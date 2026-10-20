// Local test server: serves the website and runs apps-script/Code.gs against an
// in-memory copy of the sheet, so the whole app can be tried without Google.
//
//   node dev/mock-server.mjs <grid.json> [port]
//
// grid.json: { "<tab name>": [[cell, ...], ...] } with dates written as {"$date":"yyyy-MM-dd"}.
// The API key is "test". Optional env CHART_JS=<path to chart.umd.js> serves Chart.js locally.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gridPath = process.argv[2];
const port = Number(process.argv[3] || 8080);
if (!gridPath) {
  console.error('usage: node dev/mock-server.mjs <grid.json> [port]');
  process.exit(1);
}

/* --------------------------- fake Apps Script ---------------------------- */

// Dates must come from the script's own realm, or `instanceof Date` fails inside Code.gs.
const realm = vm.createContext({});
const GasDate = vm.runInContext('Date', realm);
const raw = JSON.parse(fs.readFileSync(gridPath, 'utf8'));
const toCell = (v) => (v && typeof v === 'object' && v.$date ? new GasDate(`${v.$date}T00:00:00Z`) : v);
const sheets = {};
for (const [name, rows] of Object.entries(raw)) sheets[name] = rows.map((r) => r.map(toCell));

class Range {
  constructor(sheet, row, col, nr = 1, nc = 1) { Object.assign(this, { sheet, row, col, nr, nc }); }
  cells() { return sheets[this.sheet.name]; }
  getValues() {
    const g = this.cells();
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (g[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('setValues: size mismatch');
    const g = this.cells();
    vals.forEach((line, r) => line.forEach((v, c) => {
      const R = this.row - 1 + r;
      while (g.length <= R) g.push([]);
      g[R][this.col - 1 + c] = v;
    }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(''))); }
  getDataValidation() {
    if (this.sheet.name === 'Καταγραφή' && this.col === 5) {
      return { getCriteriaValues: () => [['Αθηνά', 'Γιάννης', 'Κοινό'], true] };
    }
    return null;
  }
}

class Sheet {
  constructor(name) { this.name = name; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a);
      const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      return new Range(this, +m[2], col(m[1]), +m[4] - +m[2] + 1, col(m[3]) - col(m[1]) + 1);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
  getLastRow() {
    const g = sheets[this.name];
    for (let r = g.length - 1; r >= 0; r--) if ((g[r] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r + 1;
    return 0;
  }
}

const props = new Map([['API_KEY', 'test']]);
const pad = (n) => String(n).padStart(2, '0');
const context = Object.assign(realm, {
  SpreadsheetApp: {
    getActive: () => ({
      getSheetByName: (n) => (sheets[n] ? new Sheet(n) : null),
      getSpreadsheetTimeZone: () => 'UTC',
    }),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => props.get(k) ?? null,
      setProperty: (k, v) => props.set(k, v),
      deleteProperty: (k) => props.delete(k),
    }),
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, _tz, p) => {
      const s = { yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()) };
      return p.replace('yyyy', s.yyyy).replace('MM', s.MM).replace('dd', s.dd);
    },
    parseDate: (s) => new GasDate(`${s}T00:00:00Z`),
  },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  },
  Logger: { log: (...a) => console.log('[gas]', ...a) },
  console,
});
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), context);

/* ------------------------------ HTTP server ------------------------------ */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain' };
const delay = Number(process.env.DELAY || 300);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => setTimeout(() => {
      const out = context.doPost({ postData: { contents: body } });
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(out.text);
    }, delay));
    return;
  }
  if (url.pathname === '/__grid') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(sheets));
  }
  if (url.pathname === '/__chart.js' && process.env.CHART_JS) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(fs.readFileSync(process.env.CHART_JS));
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}  (script URL: http://localhost:${port}/exec, key: test)`));
