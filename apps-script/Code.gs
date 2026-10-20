/**
 * Budget tracker API for the "Μηνιαία Έξοδα" Google Sheet.
 *
 * The website sends every request as a POST with a JSON body:
 *   { key: "<secret>", action: "<name>", ...fields }
 * and gets back JSON: { ok: true, ... } or { ok: false, error: "..." }.
 *
 * Setup (once): see README.md. In short: paste this file into
 * Extensions > Apps Script, run setup(), then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone).
 */

var SHEET_DASHBOARD = 'Έλεγχος μήνα';
var SHEET_LOG = 'Καταγραφή';
var SHEET_PLANS = 'Ιστορικό και πλάνα';

// Log table: header on row 4, data rows 5..2001, columns A..G.
var LOG_FIRST_ROW = 5;
var LOG_LAST_ROW = 2001;
var LOG_COLS = 7; // A Date, B Category, C Description, D Amount, E Who paid, F Comments, G ID

// Month limits: A Month, B Cap, C Warning ratio (rows 5..).
// Category plans: H Month, I Category, J Type, K Plan (rows 5..).
var PLANS_FIRST_ROW = 5;

// Category list on the dashboard tab (A16:A32). It also feeds the log's category dropdown.
var CATEGORY_RANGE = 'A16:A32';

var DEFAULT_PAYERS = ['Αθηνά', 'Γιάννης', 'Κοινό'];

/* ------------------------------------------------------------------ setup */

/** Run once from the Apps Script editor. Creates the secret key and the ID column. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('API_KEY', key);
  }
  var log = sheet_(SHEET_LOG);
  log.getRange(LOG_FIRST_ROW - 1, LOG_COLS).setValue('ID');
  assignMissingIds_(log);
  Logger.log('Your secret key (paste it into the website settings): ' + key);
  return key;
}

/** Run this if you ever want a new key (the old one stops working). */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  return setup();
}

/* --------------------------------------------------------------- endpoints */

function doGet() {
  return json_({ ok: true, message: 'Budget tracker API is running.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Invalid JSON' });
  }

  var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected || req.key !== expected) {
    return json_({ ok: false, error: 'unauthorized' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    switch (req.action) {
      case 'read': return json_(read_());
      case 'add': return json_(addEntry_(req.entry));
      case 'update': return json_(updateEntry_(req.id, req.entry));
      case 'delete': return json_(deleteEntry_(req.id));
      case 'setMonth': return json_(setMonth_(req));
      case 'setPlan': return json_(setPlan_(req));
      default: return json_({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------------------------------------------- read */

function read_() {
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  var log = sheet_(SHEET_LOG);
  assignMissingIds_(log);

  var rows = log.getRange(LOG_FIRST_ROW, 1, LOG_LAST_ROW - LOG_FIRST_ROW + 1, LOG_COLS).getValues();
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (isEmptyRow_(r)) continue;
    entries.push({
      id: String(r[6]),
      date: fmtDate_(r[0], tz, 'yyyy-MM-dd'),
      category: String(r[1]),
      description: String(r[2]),
      amount: toNumber_(r[3]),
      payer: String(r[4]),
      comments: String(r[5])
    });
  }

  var plansSheet = sheet_(SHEET_PLANS);
  var last = plansSheet.getLastRow();
  var months = [];
  var plans = [];
  if (last >= PLANS_FIRST_ROW) {
    var n = last - PLANS_FIRST_ROW + 1;
    var m = plansSheet.getRange(PLANS_FIRST_ROW, 1, n, 3).getValues();
    for (var a = 0; a < m.length; a++) {
      if (!(m[a][0] instanceof Date)) continue;
      months.push({
        month: fmtDate_(m[a][0], tz, 'yyyy-MM'),
        cap: toNumber_(m[a][1]),
        warn: m[a][2] === '' ? 0.8 : toNumber_(m[a][2])
      });
    }
    var p = plansSheet.getRange(PLANS_FIRST_ROW, 8, n, 4).getValues();
    for (var b = 0; b < p.length; b++) {
      if (!(p[b][0] instanceof Date) || p[b][1] === '') continue;
      plans.push({
        month: fmtDate_(p[b][0], tz, 'yyyy-MM'),
        category: String(p[b][1]),
        type: String(p[b][2]),
        plan: p[b][3] === '' ? null : toNumber_(p[b][3])
      });
    }
  }

  var categories = sheet_(SHEET_DASHBOARD).getRange(CATEGORY_RANGE).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (c) { return c !== ''; });

  return {
    ok: true,
    entries: entries,
    months: months,
    plans: plans,
    categories: categories,
    payers: readPayers_(log),
    updatedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------- write */

function addEntry_(entry) {
  var values = entryValues_(entry);
  var log = sheet_(SHEET_LOG);
  var row = firstEmptyRow_(log);
  if (!row) throw new Error('The log is full (2000 rows). Add more rows in the sheet.');
  var id = Utilities.getUuid();
  values.push(id);
  log.getRange(row, 1, 1, LOG_COLS).setValues([values]);
  return { ok: true, id: id };
}

function updateEntry_(id, entry) {
  var log = sheet_(SHEET_LOG);
  var row = findRowById_(log, id);
  if (!row) throw new Error('Payment not found. It may have been deleted. Refresh and try again.');
  var values = entryValues_(entry);
  values.push(id);
  log.getRange(row, 1, 1, LOG_COLS).setValues([values]);
  return { ok: true, id: id };
}

function deleteEntry_(id) {
  var log = sheet_(SHEET_LOG);
  var row = findRowById_(log, id);
  if (!row) throw new Error('Payment not found. It may already be deleted.');
  // Clear instead of deleting the row, so the sheet's formulas and
  // dropdowns (which cover rows 5..2001) keep their exact ranges.
  log.getRange(row, 1, 1, LOG_COLS).clearContent();
  return { ok: true, id: id };
}

/** req: { month: 'yyyy-MM', cap: number, warn: number (0..1), forward: bool } */
function setMonth_(req) {
  var cap = Number(req.cap);
  var warn = Number(req.warn);
  if (!isFinite(cap) || cap < 0) throw new Error('Invalid limit');
  if (!isFinite(warn) || warn <= 0 || warn > 1) throw new Error('Warning must be between 1% and 100%');
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  var sh = sheet_(SHEET_PLANS);
  var last = sh.getLastRow();
  var vals = sh.getRange(PLANS_FIRST_ROW, 1, last - PLANS_FIRST_ROW + 1, 1).getValues();
  var changed = 0;
  for (var i = 0; i < vals.length; i++) {
    if (!(vals[i][0] instanceof Date)) continue;
    var m = fmtDate_(vals[i][0], tz, 'yyyy-MM');
    if (m === req.month || (req.forward && m > req.month)) {
      sh.getRange(PLANS_FIRST_ROW + i, 2, 1, 2).setValues([[cap, warn]]);
      changed++;
    }
  }
  if (!changed) throw new Error('Month not found in the sheet: ' + req.month);
  return { ok: true, changed: changed };
}

/** req: { month: 'yyyy-MM', category, type: 'Πάγιο'|'Επιπλέον', plan: number|null, forward: bool } */
function setPlan_(req) {
  if (req.type !== 'Πάγιο' && req.type !== 'Επιπλέον') throw new Error('Invalid type');
  var plan = req.plan === null || req.plan === '' || req.plan === undefined ? '' : Number(req.plan);
  if (plan !== '' && (!isFinite(plan) || plan < 0)) throw new Error('Invalid amount');
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  var sh = sheet_(SHEET_PLANS);
  var last = sh.getLastRow();
  var vals = sh.getRange(PLANS_FIRST_ROW, 8, last - PLANS_FIRST_ROW + 1, 2).getValues();
  var changed = 0;
  for (var i = 0; i < vals.length; i++) {
    if (!(vals[i][0] instanceof Date) || String(vals[i][1]) !== req.category) continue;
    var m = fmtDate_(vals[i][0], tz, 'yyyy-MM');
    if (m === req.month || (req.forward && m > req.month)) {
      sh.getRange(PLANS_FIRST_ROW + i, 10, 1, 2).setValues([[req.type, plan]]);
      changed++;
    }
  }
  if (!changed) throw new Error('No plan row for ' + req.category + ' in ' + req.month);
  return { ok: true, changed: changed };
}

/* ----------------------------------------------------------------- helpers */

function entryValues_(entry) {
  if (!entry) throw new Error('Missing payment');
  var date = parseDate_(entry.date);
  var amount = Number(entry.amount);
  if (!isFinite(amount) || amount === 0) throw new Error('Invalid amount');
  if (!entry.category) throw new Error('Choose a category');
  return [
    date,
    String(entry.category),
    String(entry.description || ''),
    Math.round(amount * 100) / 100,
    String(entry.payer || ''),
    String(entry.comments || '')
  ];
}

function parseDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error('Invalid date');
  // Midnight in the spreadsheet's own time zone, like a date typed into the sheet.
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return Utilities.parseDate(m[0], tz, 'yyyy-MM-dd');
}

function isEmptyRow_(r) {
  return r[0] === '' && r[1] === '' && r[3] === '';
}

function firstEmptyRow_(log) {
  var vals = log.getRange(LOG_FIRST_ROW, 1, LOG_LAST_ROW - LOG_FIRST_ROW + 1, 4).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (isEmptyRow_(vals[i])) return LOG_FIRST_ROW + i;
  }
  return 0;
}

function findRowById_(log, id) {
  if (!id) return 0;
  var ids = log.getRange(LOG_FIRST_ROW, LOG_COLS, LOG_LAST_ROW - LOG_FIRST_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return LOG_FIRST_ROW + i;
  }
  return 0;
}

/** Rows typed straight into the sheet have no ID yet: give them one. */
function assignMissingIds_(log) {
  var n = LOG_LAST_ROW - LOG_FIRST_ROW + 1;
  var range = log.getRange(LOG_FIRST_ROW, 1, n, LOG_COLS);
  var rows = range.getValues();
  var ids = [];
  var dirty = false;
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i][6];
    if (isEmptyRow_(rows[i])) {
      if (id !== '') { id = ''; dirty = true; } // stray ID on a cleared row
    } else if (id === '') {
      id = Utilities.getUuid();
      dirty = true;
    }
    ids.push([id]);
  }
  if (dirty) log.getRange(LOG_FIRST_ROW, LOG_COLS, n, 1).setValues(ids);
}

function readPayers_(log) {
  try {
    var rule = log.getRange(LOG_FIRST_ROW, 5).getDataValidation();
    if (rule) {
      var vals = rule.getCriteriaValues()[0];
      if (vals && vals.length) return vals.map(String);
    }
  } catch (err) { /* fall back below */ }
  return DEFAULT_PAYERS;
}

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Tab not found: ' + name);
  return sh;
}

function fmtDate_(d, tz, pattern) {
  if (!(d instanceof Date)) return String(d || '');
  return Utilities.formatDate(d, tz, pattern);
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
