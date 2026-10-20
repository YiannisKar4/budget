import { call, loadSettings, saveSettings, ApiError } from './api.js';
import { monthSummary, defaultMonth, monthOf, addMonths, FIXED, EXTRA, STATUS } from './calc.js';
import { buildSeries, drawChart, chartHeight, euro, GROUPS, SPLITS, KINDS, PERIODS, DEFAULT_CHARTS, monthShort } from './charts.js';

/* ------------------------------------------------------------------ state */

const CACHE_KEY = 'budget.cache';
const CHARTS_KEY = 'budget.charts';
const VIEWS = ['overview', 'entries', 'charts', 'plans'];

const state = {
  settings: loadSettings(),
  data: null,
  month: null,
  view: 'overview',
  loading: false,
  lastFetch: 0,
  entryFilter: { q: '', category: '', payer: '', scope: 'month' },
  chartPayer: '',
  charts: loadCharts(),
  chartInstances: [],
  editingEntry: null,
  editingChart: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
const monthLong = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const DAYS = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pct = (v) => `${Math.round(v * 100)}%`;
const parseAmount = (s) => {
  const t = String(s).replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
};
const fmtAmountInput = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','));

const ICON = {
  over: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  near: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>',
  noplan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
};
ICON.paid = ICON.ok;

const STATUS_LABEL = {
  [STATUS.OVER]: 'Υπέρβαση',
  [STATUS.NEAR]: 'Κοντά στο όριο',
  [STATUS.OK]: 'Εντός πλάνου',
  [STATUS.PAID]: 'Πληρώθηκε',
  [STATUS.NOPLAN]: 'Χωρίς πλάνο',
};
const pill = (status, label = STATUS_LABEL[status]) => `<span class="pill ${status}">${ICON[status] || ''}${esc(label)}</span>`;

/* ----------------------------------------------------------------- storage */

function loadCharts() {
  try {
    const c = JSON.parse(localStorage.getItem(CHARTS_KEY));
    if (Array.isArray(c) && c.length) return c;
  } catch { /* use defaults */ }
  return structuredClone(DEFAULT_CHARTS);
}
function saveCharts() {
  try { localStorage.setItem(CHARTS_KEY, JSON.stringify(state.charts)); } catch { /* ignore */ }
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.data)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------- toast */

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2600);
}

/* -------------------------------------------------------------------- data */

async function fetchData({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').classList.add('spin');
  $('#main').classList.toggle('stale', !!state.data);
  try {
    const body = await call(state.settings, 'read');
    state.data = {
      entries: body.entries,
      months: body.months,
      plans: body.plans,
      categories: body.categories,
      payers: body.payers,
      updatedAt: body.updatedAt,
    };
    state.lastFetch = Date.now();
    saveCache();
    if (!state.month) state.month = defaultMonth(state.data);
    renderAll();
  } catch (err) {
    if (!quiet || !state.data) toast(err.message, true);
    if (!state.data) renderAll();
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
    $('#main').classList.remove('stale');
  }
}

function configured() {
  return !!(state.settings.url && state.settings.key);
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  const ready = configured() && state.data;
  $('#tabs-wrap').hidden = !ready;
  $('#fab').hidden = !ready || state.view === 'plans';
  $('#month-picker').hidden = !ready;
  $('#refresh').hidden = !configured();
  if (!configured()) return renderSetup();
  if (!state.data) {
    $('#main').innerHTML = `<div class="empty">${state.loading ? 'Φόρτωση από το Google Sheet…' : 'Δεν ήταν δυνατή η φόρτωση. Πάτα ανανέωση ή έλεγξε τις Ρυθμίσεις.'}</div>`;
    return;
  }
  renderMonthPicker();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
  $('#updated').textContent = state.data.updatedAt
    ? `Ενημέρωση ${new Date(state.data.updatedAt).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  destroyCharts();
  ({ overview: renderOverview, entries: renderEntries, charts: renderCharts, plans: renderPlans })[state.view]();
}

function allMonths() {
  const set = new Set(state.data.months.map((m) => m.month));
  for (const e of state.data.entries) set.add(monthOf(e.date));
  set.add(state.month);
  return [...set].filter(Boolean).sort();
}

function renderMonthPicker() {
  const sel = $('#month');
  const months = allMonths();
  sel.innerHTML = months.map((m) => `<option value="${m}">${monthLong(m)}</option>`).join('');
  sel.value = state.month;
}

function setMonth(m) {
  state.month = m;
  renderAll();
}

/* -------- setup -------- */

function settingsFieldsHtml() {
  return `
    <label class="lbl" for="s-url">Διεύθυνση του Google script (τελειώνει σε /exec)</label>
    <input class="field" id="s-url" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.settings.url || '')}">
    <label class="lbl" for="s-key">Μυστικό κλειδί</label>
    <input class="field" id="s-key" type="password" autocomplete="off" value="${esc(state.settings.key || '')}">`;
}

function renderSetup() {
  $('#main').innerHTML = `
    <div class="setup card">
      <h1>Σύνδεση με το Google Sheet</h1>
      <p class="muted">Η σελίδα διαβάζει και γράφει απευθείας στο δικό σας Google Sheet. Χρειάζεται μία φορά σε κάθε συσκευή:</p>
      <ol>
        <li>Τη διεύθυνση του Google script (Deploy → Web app URL).</li>
        <li>Το μυστικό κλειδί που εμφανίζει η εντολή <code>setup</code>.</li>
      </ol>
      <form id="setup-form" novalidate>
        ${settingsFieldsHtml()}
        <div class="err" id="setup-err" hidden></div>
        <div class="row-actions"><button class="btn primary" type="submit">Σύνδεση</button></div>
      </form>
      <p class="note">Τα στοιχεία αποθηκεύονται μόνο σε αυτή τη συσκευή. Οδηγίες εγκατάστασης υπάρχουν στο README του project.</p>
    </div>`;
  $('#setup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await connect($('#s-url').value, $('#s-key').value, $('#setup-err'), ev.submitter);
  });
}

async function connect(url, key, errEl, btn) {
  const candidate = { ...state.settings, url: url.trim(), key: key.trim() };
  errEl.hidden = true;
  if (!/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/localhost[:/])/.test(candidate.url)) {
    errEl.textContent = 'Η διεύθυνση πρέπει να ξεκινά με https://script.google.com/';
    errEl.hidden = false;
    return false;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Έλεγχος…'; }
  try {
    await call(candidate, 'read');
    state.settings = candidate;
    saveSettings(state.settings);
    await fetchData();
    return true;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Σύνδεση'; }
  }
}

/* -------- overview -------- */

function renderOverview() {
  const s = monthSummary(state.data, state.month);
  const banner = {
    [STATUS.OVER]: ['Υπέρβαση ορίου', `Με τα πάγια που απομένουν ο μήνας φτάνει τα ${euro(s.spentPlusFixed)}, δηλαδή ${euro(s.spentPlusFixed - s.cap)} πάνω από το ταβάνι των ${euro(s.cap)}.`],
    [STATUS.NEAR]: ['Κοντά στο όριο', `Με τα πάγια που απομένουν ο μήνας φτάνει τα ${euro(s.spentPlusFixed)} από τα ${euro(s.cap)} (ειδοποίηση στο ${pct(s.warn)}).`],
    [STATUS.OK]: ['Κάτω από το όριο', `Μένουν ${euro(s.available)} διαθέσιμα αφού πληρωθούν και τα πάγια.`],
  }[s.statusWithFixed];

  const fill = s.cap ? Math.min(100, (s.spent / s.cap) * 100) : 0;
  const notes = [];
  if (s.limitsMissing) notes.push('Δεν υπάρχει ταβάνι για αυτόν τον μήνα στο Ιστορικό και πλάνα.');
  if (s.missingPlans) notes.push(`Λείπει το ποσό πλάνου σε ${s.missingPlans} ${s.missingPlans === 1 ? 'κατηγορία' : 'κατηγορίες'}, οπότε το διαθέσιμο είναι προσωρινό.`);
  if (s.planOverCap) notes.push(`Το συνολικό πλάνο (${euro(s.totals.plan)}) ξεπερνά το ταβάνι κατά ${euro(s.planOverCap)}.`);
  if (s.uncategorised) notes.push(`${euro(s.uncategorised)} είναι σε κατηγορίες που δεν υπάρχουν στη λίστα.`);

  const row = (r) => {
    const ratio = r.plan ? r.paid / r.plan : r.paid ? 1 : 0;
    const cls = r.status === STATUS.OVER ? 'over' : r.status === STATUS.NEAR ? 'near' : '';
    const meta = r.plan === null ? 'Χωρίς πλάνο' : r.over ? `Υπέρβαση ${euro(r.over)}` : r.remaining ? `Απομένουν ${euro(r.remaining)}` : 'Ολοκληρώθηκε';
    return `
      <li class="cat-row" data-category="${esc(r.category)}" tabindex="0">
        <div class="name"><span>${esc(r.category)}</span></div>
        <div class="amounts">${euro(r.paid)} <small>/ ${r.plan === null ? '—' : euro(r.plan)}</small></div>
        <div class="bar"><i class="${cls}" style="width:${Math.min(100, ratio * 100)}%"></i></div>
        <div class="meta"><span>${meta}</span>${pill(r.status)}</div>
      </li>`;
  };
  const fixed = s.rows.filter((r) => r.type === FIXED);
  const extra = s.rows.filter((r) => r.type === EXTRA);

  $('#main').innerHTML = `
    <div class="banner ${s.statusWithFixed}">
      <div class="dot">${ICON[s.statusWithFixed]}</div>
      <div><strong>${banner[0]}</strong><span class="small muted">${esc(banner[1])}</span></div>
    </div>
    <div class="tiles">
      <div class="card tile">
        <div class="label">Πραγματικά έξοδα</div>
        <div class="value">${euro(s.spent)}</div>
        <div class="sub">από ${euro(s.cap)} ταβάνι · ${s.count} πληρωμές</div>
        <div class="bar"><i class="${s.statusActual === STATUS.OVER ? 'over' : s.statusActual === STATUS.NEAR ? 'near' : ''}" style="width:${fill}%"></i><b style="left:${s.warn * 100}%" title="Ειδοποίηση ${pct(s.warn)}"></b></div>
      </div>
      <div class="card tile">
        <div class="label">Πάγια που απομένουν</div>
        <div class="value">${euro(s.fixedRemaining)}</div>
        <div class="sub">λογαριασμοί που δεν πληρώθηκαν ακόμα</div>
      </div>
      <div class="card tile ${s.available < 0 ? 'neg' : ''}">
        <div class="label">Διαθέσιμο μετά τα πάγια</div>
        <div class="value">${euro(s.available)}</div>
        <div class="sub">ταβάνι − έξοδα − πάγια</div>
      </div>
      <div class="card tile ${s.overActual > 0 ? 'neg' : ''}">
        <div class="label">Υπέρβαση ταβανιού</div>
        <div class="value">${euro(s.overActual)}</div>
        <div class="sub">πραγματικά έξοδα πάνω από το ταβάνι</div>
      </div>
    </div>
    ${notes.length ? `<div class="note">${notes.map(esc).join('<br>')}</div>` : ''}
    <div class="card" style="margin-top:12px">
      <div class="card-head"><h2>Κατηγορίες: πληρωμένα / πλάνο</h2>${pill(s.totals.status)}</div>
      ${fixed.length ? `<div class="section-label">Πάγια</div><ul class="cat-list">${fixed.map(row).join('')}</ul>` : ''}
      ${extra.length ? `<div class="section-label">Επιπλέον</div><ul class="cat-list">${extra.map(row).join('')}</ul>` : ''}
      <div class="totals-row"><span>Σύνολο</span><span class="num">${euro(s.totals.paid)} / ${euro(s.totals.plan)}</span></div>
    </div>`;

  document.querySelectorAll('.cat-row').forEach((el) => {
    const go = () => {
      state.entryFilter = { ...state.entryFilter, category: el.dataset.category, q: '', scope: 'month' };
      go_('entries');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  });
}

/* -------- entries -------- */

function renderEntries() {
  const f = state.entryFilter;
  const d = state.data;
  const q = f.q.trim().toLowerCase();
  const list = d.entries
    .filter((e) => f.scope === 'all' || monthOf(e.date) === state.month)
    .filter((e) => !f.category || e.category === f.category)
    .filter((e) => !f.payer || e.payer === f.payer)
    .filter((e) => !q || `${e.description} ${e.comments} ${e.category}`.toLowerCase().includes(q))
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const total = list.reduce((s, e) => s + e.amount, 0);

  let html = '';
  let lastDate = '';
  for (const e of list) {
    if (e.date !== lastDate) {
      const dayTotal = list.filter((x) => x.date === e.date).reduce((s, x) => s + x.amount, 0);
      const dt = new Date(`${e.date}T12:00:00`);
      html += `<div class="day-head"><span>${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}${f.scope === 'all' ? ` ${dt.getFullYear()}` : ''}</span><span class="num">${euro(dayTotal)}</span></div>`;
      lastDate = e.date;
    }
    const sub = [e.description, e.payer, e.comments].filter(Boolean).map(esc).join(' · ');
    html += `<button class="entry" data-id="${esc(e.id)}"><span class="t">${esc(e.category)}</span><span class="a">${euro(e.amount)}</span><span class="s">${sub || '&nbsp;'}</span></button>`;
  }

  $('#main').innerHTML = `
    <div class="filters">
      <input id="ef-q" type="search" placeholder="Αναζήτηση" value="${esc(f.q)}">
      <select id="ef-cat"><option value="">Όλες οι κατηγορίες</option>${d.categories.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="ef-payer"><option value="">Όλοι</option>${d.payers.map((p) => `<option ${p === f.payer ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="ef-scope"><option value="month">${monthLong(state.month)}</option><option value="all" ${f.scope === 'all' ? 'selected' : ''}>Όλοι οι μήνες</option></select>
    </div>
    <div class="list-total"><span>${list.length} ${list.length === 1 ? 'πληρωμή' : 'πληρωμές'}</span><span class="num">${euro(total)}</span></div>
    ${list.length ? html : '<div class="empty">Δεν υπάρχουν πληρωμές με αυτά τα φίλτρα.</div>'}`;

  const upd = (k) => (ev) => {
    state.entryFilter[k] = ev.target.value;
    const pos = ev.target.selectionStart;
    renderEntries();
    if (k === 'q') { const i = $('#ef-q'); i.focus(); i.setSelectionRange(pos, pos); }
  };
  $('#ef-q').addEventListener('input', upd('q'));
  $('#ef-cat').addEventListener('change', upd('category'));
  $('#ef-payer').addEventListener('change', upd('payer'));
  $('#ef-scope').addEventListener('change', upd('scope'));
  document.querySelectorAll('.entry').forEach((el) =>
    el.addEventListener('click', () => openEntry(state.data.entries.find((e) => e.id === el.dataset.id))),
  );
}

/* -------- entry dialog -------- */

function openEntry(entry = null) {
  const d = state.data;
  state.editingEntry = entry;
  $('#entry-title').textContent = entry ? 'Επεξεργασία πληρωμής' : 'Νέα πληρωμή';
  $('#entry-delete').hidden = !entry;
  $('#entry-err').hidden = true;
  const cats = [...d.categories];
  if (entry && !cats.includes(entry.category)) cats.push(entry.category);
  $('#f-category').innerHTML = `<option value="">Διάλεξε κατηγορία</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}`;
  const defaultDate = monthOf(todayIso()) === state.month ? todayIso() : `${state.month}-01`;
  $('#f-amount').value = entry ? fmtAmountInput(entry.amount) : '';
  $('#f-category').value = entry ? entry.category : '';
  $('#f-date').value = entry ? entry.date : defaultDate;
  $('#f-desc').value = entry ? entry.description : '';
  $('#f-comments').value = entry ? entry.comments : '';
  const payer = entry ? entry.payer : state.settings.lastPayer || d.payers[0];
  $('#f-payer').innerHTML = d.payers.map((p) => `<button type="button" aria-pressed="${p === payer}">${esc(p)}</button>`).join('');
  updateSuggestions();
  $('#entry-dlg').showModal();
  if (!entry) setTimeout(() => $('#f-amount').focus(), 50);
}

function updateSuggestions() {
  const cat = $('#f-category').value;
  const counts = new Map();
  for (const e of state.data.entries) if (e.description && (!cat || e.category === cat)) counts.set(e.description, (counts.get(e.description) || 0) + 1);
  $('#desc-suggestions').innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([v]) => `<option value="${esc(v)}">`).join('');
}

async function saveEntry(ev) {
  ev.preventDefault();
  const err = $('#entry-err');
  const amount = parseAmount($('#f-amount').value);
  const payerBtn = $('#f-payer [aria-pressed="true"]');
  const entry = {
    date: $('#f-date').value,
    category: $('#f-category').value,
    description: $('#f-desc').value.trim(),
    amount: Math.round(amount * 100) / 100,
    payer: payerBtn ? payerBtn.textContent : '',
    comments: $('#f-comments').value.trim(),
  };
  const problem = !isFinite(amount) || amount === 0 ? 'Γράψε ένα ποσό.' : !entry.category ? 'Διάλεξε κατηγορία.' : !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? 'Διάλεξε ημερομηνία.' : '';
  if (problem) { err.textContent = problem; err.hidden = false; return; }

  const editing = state.editingEntry;
  const btn = $('#entry-save');
  btn.disabled = true;
  btn.textContent = 'Αποθήκευση…';
  try {
    if (editing) {
      await call(state.settings, 'update', { id: editing.id, entry });
      Object.assign(editing, entry);
    } else {
      const res = await call(state.settings, 'add', { entry });
      state.data.entries.push({ ...entry, id: res.id });
    }
    state.settings.lastPayer = entry.payer;
    saveSettings(state.settings);
    saveCache();
    $('#entry-dlg').close();
    if (monthOf(entry.date) !== state.month) state.month = monthOf(entry.date);
    renderAll();
    toast(editing ? 'Η πληρωμή άλλαξε' : `Καταχωρίστηκε: ${euro(entry.amount)} · ${entry.category}`);
    fetchData({ quiet: true });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Αποθήκευση';
  }
}

async function deleteEntry() {
  const e = state.editingEntry;
  if (!e || !confirm(`Διαγραφή της πληρωμής ${euro(e.amount)} (${e.category});`)) return;
  const btn = $('#entry-delete');
  btn.disabled = true;
  try {
    await call(state.settings, 'delete', { id: e.id });
    state.data.entries = state.data.entries.filter((x) => x.id !== e.id);
    saveCache();
    $('#entry-dlg').close();
    renderAll();
    toast('Η πληρωμή διαγράφηκε');
    fetchData({ quiet: true });
  } catch (err) {
    $('#entry-err').textContent = err.message;
    $('#entry-err').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* -------- charts -------- */

function destroyCharts() {
  state.chartInstances.forEach((c) => c.destroy());
  state.chartInstances = [];
}

function chartSubtitle(cfg) {
  const period = cfg.period === 'month' ? monthLong(state.month) : `${PERIODS[cfg.period]} έως ${monthShort(state.month)}`;
  const cats = cfg.categories && cfg.categories.length ? ` · ${cfg.categories.length} κατηγορίες` : '';
  return `${period}${cats}${state.chartPayer ? ` · ${state.chartPayer}` : ''}`;
}

function tableHtml(built) {
  const cols = built.series.map((s) => s.label);
  if (built.reference) cols.push(built.reference.label);
  const rows = built.labels.map((l, i) => {
    const vals = built.series.map((s) => s.values[i]);
    if (built.reference) vals.push(built.reference.values[i]);
    return `<tr><td>${esc(l)}</td>${vals.map((v) => `<td>${v === null ? "—" : euro(v)}</td>`).join('')}</tr>`;
  });
  return `<div class="table-scroll"><table class="chart-table"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderCharts() {
  const d = state.data;
  $('#main').innerHTML = `
    <div class="filters">
      <select id="cf-payer" aria-label="Ποιος πλήρωσε"><option value="">Όλοι</option>${d.payers.map((p) => `<option ${p === state.chartPayer ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <button class="btn" id="chart-add">+ Νέο γράφημα</button>
      <button class="btn" id="chart-reset">Επαναφορά</button>
    </div>
    <div class="chart-grid" id="chart-grid"></div>`;
  $('#cf-payer').addEventListener('change', (e) => { state.chartPayer = e.target.value; renderAll(); });
  $('#chart-add').addEventListener('click', () => openChart(null));
  $('#chart-reset').addEventListener('click', () => {
    if (!confirm('Επαναφορά των αρχικών γραφημάτων;')) return;
    state.charts = structuredClone(DEFAULT_CHARTS);
    saveCharts();
    renderAll();
  });

  const grid = $('#chart-grid');
  const ctx = { month: state.month, payer: state.chartPayer, today: todayIso() };
  state.charts.forEach((cfg, i) => {
    const built = buildSeries(d, cfg, ctx);
    const card = document.createElement('section');
    card.className = `card chart-card${cfg.wide ? ' wide' : ''}`;
    card.innerHTML = `
      <div class="card-head">
        <h2>${esc(cfg.title || GROUPS[cfg.groupBy])}<div class="sub">${esc(chartSubtitle(cfg))}</div></h2>
        <div class="chart-tools">
          <button class="icon-btn" data-act="table" title="Πίνακας / γράφημα" aria-label="Πίνακας">${cfg.showTable ? ICON.chart : ICON.table}</button>
          <button class="icon-btn" data-act="up" title="Πάνω" aria-label="Μετακίνηση πάνω" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="icon-btn" data-act="down" title="Κάτω" aria-label="Μετακίνηση κάτω" ${i === state.charts.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="icon-btn" data-act="edit" title="Ρυθμίσεις γραφήματος" aria-label="Επεξεργασία">${ICON.edit}</button>
        </div>
      </div>
      <div class="chart-body"></div>`;
    grid.appendChild(card);
    const body = $('.chart-body', card);
    if (built.empty) {
      body.innerHTML = '<div class="chart-empty">Δεν υπάρχουν πληρωμές για αυτή την περίοδο.</div>';
    } else if (cfg.showTable || !window.Chart) {
      body.innerHTML = tableHtml(built) + (window.Chart ? '' : '<p class="small muted">Τα γραφήματα δεν φορτώθηκαν (χωρίς internet;). Εμφανίζεται πίνακας.</p>');
    } else {
      body.innerHTML = `<div class="chart-box" style="height:${chartHeight(cfg, built)}px"><canvas role="img" aria-label="${esc(cfg.title)}"></canvas></div>`;
      state.chartInstances.push(drawChart($('canvas', body), cfg, built, d));
    }
    card.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'edit') return openChart(cfg);
        if (act === 'table') cfg.showTable = !cfg.showTable;
        if (act === 'up' || act === 'down') {
          const j = act === 'up' ? i - 1 : i + 1;
          [state.charts[i], state.charts[j]] = [state.charts[j], state.charts[i]];
        }
        saveCharts();
        renderAll();
      }),
    );
  });
}

function fillSelect(sel, options, value) {
  sel.innerHTML = Object.entries(options).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  sel.value = value;
}

function openChart(cfg) {
  state.editingChart = cfg;
  const c = cfg || { title: '', groupBy: 'category', splitBy: 'none', kind: 'bar', period: 'month', showPlan: true, cumulative: false, categories: [] };
  $('#chart-dlg-title').textContent = cfg ? 'Ρυθμίσεις γραφήματος' : 'Νέο γράφημα';
  $('#chart-delete').hidden = !cfg;
  $('#c-title').value = c.title;
  fillSelect($('#c-group'), GROUPS, c.groupBy);
  fillSelect($('#c-kind'), KINDS, c.kind);
  fillSelect($('#c-period'), PERIODS, String(c.period));
  fillSelect($('#c-split'), SPLITS, c.splitBy || 'none');
  $('#c-plan').checked = !!c.showPlan;
  $('#c-cum').checked = !!c.cumulative;
  $('#c-wide').checked = !!c.wide;
  const chosen = new Set(c.categories || []);
  $('#c-cats').innerHTML = state.data.categories
    .map((cat) => `<label><input type="checkbox" value="${esc(cat)}" ${chosen.has(cat) ? 'checked' : ''}>${esc(cat)}</label>`)
    .join('');
  $('#chart-dlg').showModal();
}

function saveChart(ev) {
  ev.preventDefault();
  const groupBy = $('#c-group').value;
  const next = {
    title: $('#c-title').value.trim() || GROUPS[groupBy],
    groupBy,
    kind: $('#c-kind').value,
    period: $('#c-period').value,
    splitBy: $('#c-split').value,
    showPlan: $('#c-plan').checked,
    cumulative: $('#c-cum').checked,
    wide: $('#c-wide').checked,
    categories: [...document.querySelectorAll('#c-cats input:checked')].map((i) => i.value),
  };
  if (state.editingChart) Object.assign(state.editingChart, next);
  else state.charts.push({ id: `c${Date.now()}`, ...next });
  saveCharts();
  $('#chart-dlg').close();
  renderAll();
}

/* -------- plans -------- */

function renderPlans() {
  const d = state.data;
  const m = state.month;
  const limits = d.months.find((x) => x.month === m);
  const s = monthSummary(d, m);
  if (!limits) {
    $('#main').innerHTML = `<div class="card empty">Ο μήνας ${monthLong(m)} δεν υπάρχει στο «Ιστορικό και πλάνα». Πρόσθεσέ τον στο Google Sheet.</div>`;
    return;
  }
  $('#main').innerHTML = `
    <form id="plans-form" novalidate>
      <div class="card">
        <div class="card-head"><h2>Όρια για ${monthLong(m)}</h2></div>
        <div class="form-grid">
          <div><label class="lbl" for="p-cap">Μηνιαίο ταβάνι (€)</label><input class="field" id="p-cap" inputmode="decimal" value="${fmtAmountInput(limits.cap)}"></div>
          <div><label class="lbl" for="p-warn">Ειδοποίηση στο (%)</label><input class="field" id="p-warn" inputmode="numeric" value="${Math.round(limits.warn * 100)}"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Πλάνο ανά κατηγορία</h2><span class="muted small num">Σύνολο ${euro(s.totals.plan)}</span></div>
        ${s.rows
          .map(
            (r, i) => `
          <div class="plan-row" data-i="${i}">
            <div class="name">${esc(r.category)}</div>
            <select class="field" data-k="type" aria-label="Τύπος"><option ${r.type === FIXED ? 'selected' : ''}>${FIXED}</option><option ${r.type === EXTRA ? 'selected' : ''}>${EXTRA}</option></select>
            <input class="field num" data-k="plan" inputmode="decimal" placeholder="κενό" aria-label="Πλάνο (€)" value="${fmtAmountInput(r.plan)}">
          </div>`,
          )
          .join('')}
        <label class="check"><input type="checkbox" id="p-forward"> Ισχύει και για όλους τους επόμενους μήνες</label>
        <p class="small muted">Κενό πλάνο σημαίνει «άγνωστο ποσό». Χωρίς το τικ, η αλλαγή αφορά μόνο τον ${monthLong(m)}.</p>
        <div class="err" id="plans-err" hidden></div>
        <div class="row-actions"><button class="btn primary" type="submit" id="plans-save" disabled>Αποθήκευση αλλαγών</button></div>
      </div>
    </form>`;

  const form = $('#plans-form');
  const original = s.rows.map((r) => ({ type: r.type, plan: r.plan }));
  const changes = () => {
    const out = [];
    form.querySelectorAll('.plan-row').forEach((el) => {
      const i = Number(el.dataset.i);
      const type = $('[data-k="type"]', el).value;
      const raw = $('[data-k="plan"]', el).value.trim();
      const plan = raw === '' ? null : parseAmount(raw);
      const changed = type !== original[i].type || plan !== original[i].plan;
      el.classList.toggle('changed', changed);
      if (changed) out.push({ category: s.rows[i].category, type, plan });
    });
    const cap = parseAmount($('#p-cap').value);
    const warn = Number($('#p-warn').value) / 100;
    const monthChanged = cap !== limits.cap || Math.abs(warn - limits.warn) > 1e-9;
    $('#plans-save').disabled = !out.length && !monthChanged;
    return { rows: out, monthChanged, cap, warn };
  };
  form.addEventListener('input', changes);
  form.addEventListener('change', changes);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#plans-err');
    err.hidden = true;
    const ch = changes();
    const forward = $('#p-forward').checked;
    const bad = ch.rows.find((r) => r.plan !== null && (!isFinite(r.plan) || r.plan < 0));
    if (bad) { err.textContent = `Μη έγκυρο ποσό στο «${bad.category}».`; err.hidden = false; return; }
    if (ch.monthChanged && (!isFinite(ch.cap) || ch.cap < 0 || !(ch.warn > 0 && ch.warn <= 1))) {
      err.textContent = 'Έλεγξε το ταβάνι και την ειδοποίηση (1 έως 100%).';
      err.hidden = false;
      return;
    }
    const btn = $('#plans-save');
    btn.disabled = true;
    btn.textContent = 'Αποθήκευση…';
    try {
      if (ch.monthChanged) await call(state.settings, 'setMonth', { month: m, cap: ch.cap, warn: ch.warn, forward });
      for (const r of ch.rows) await call(state.settings, 'setPlan', { month: m, category: r.category, type: r.type, plan: r.plan, forward });
      toast('Τα πλάνα αποθηκεύτηκαν');
      await fetchData();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Αποθήκευση αλλαγών';
    }
  });
}

/* ---------------------------------------------------------------- settings */

function applyTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === t)));
}

function openSettings() {
  $('#settings-fields').innerHTML = settingsFieldsHtml();
  $('#settings-err').hidden = true;
  $('#logout').hidden = !configured();
  applyTheme();
  $('#settings-dlg').showModal();
}

/* ------------------------------------------------------------------ routing */

function go_(view) {
  state.view = VIEWS.includes(view) ? view : 'overview';
  if (location.hash !== `#${state.view}`) history.replaceState(null, '', `#${state.view}`);
  window.scrollTo(0, 0);
  renderAll();
}

/* -------------------------------------------------------------------- init */

function init() {
  applyTheme();
  state.view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go_(t.dataset.view)));
  window.addEventListener('hashchange', () => go_(location.hash.slice(1)));
  $('#month').addEventListener('change', (e) => setMonth(e.target.value));
  $('#prev-month').addEventListener('click', () => setMonth(addMonths(state.month, -1)));
  $('#next-month').addEventListener('click', () => setMonth(addMonths(state.month, 1)));
  $('#refresh').addEventListener('click', () => fetchData());
  $('#open-settings').addEventListener('click', openSettings);
  $('#fab').addEventListener('click', () => openEntry(null));

  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((dlg) =>
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }),
  );

  $('#entry-form').addEventListener('submit', saveEntry);
  $('#entry-delete').addEventListener('click', deleteEntry);
  $('#f-category').addEventListener('change', updateSuggestions);
  $('#f-payer').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#f-payer').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  $('#chart-form').addEventListener('submit', saveChart);
  $('#chart-delete').addEventListener('click', () => {
    if (!state.editingChart || !confirm('Διαγραφή αυτού του γραφήματος;')) return;
    state.charts = state.charts.filter((c) => c !== state.editingChart);
    saveCharts();
    $('#chart-dlg').close();
    renderAll();
  });

  $('#settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const url = $('#s-url').value;
    const key = $('#s-key').value;
    if (url.trim() === (state.settings.url || '') && key.trim() === (state.settings.key || '')) {
      $('#settings-dlg').close();
      return;
    }
    const ok = await connect(url, key, $('#settings-err'), ev.submitter);
    if (ok) $('#settings-dlg').close();
  });
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-choice]');
    if (!b) return;
    state.settings.theme = b.dataset.themeChoice;
    saveSettings(state.settings);
    applyTheme();
    renderAll();
  });
  $('#logout').addEventListener('click', () => {
    if (!confirm('Να αφαιρεθούν η σύνδεση και τα αποθηκευμένα δεδομένα από αυτή τη συσκευή;')) return;
    const theme = state.settings.theme;
    state.settings = { theme };
    saveSettings(state.settings);
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    state.data = null;
    state.month = null;
    $('#settings-dlg').close();
    renderAll();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.view === 'charts' && renderAll());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && configured() && Date.now() - state.lastFetch > 60_000) fetchData({ quiet: true });
  });

  if (configured()) {
    const cached = loadCache();
    if (cached && cached.entries) {
      state.data = cached;
      state.month = defaultMonth(cached);
    }
    renderAll();
    fetchData({ quiet: !!state.data });
  } else {
    renderAll();
  }
}

init();
