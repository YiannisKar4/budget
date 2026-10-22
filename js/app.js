import { call, loadSettings, saveSettings, ApiError, usesSupabase } from './api.js?v=15';
import * as supa from './supa.js?v=15';
import { STORAGE_PREFIX } from './config.js?v=15';
import { monthSummary, defaultMonth, monthOf, addMonths, FIXED, EXTRA, STATUS, looseText } from './calc.js?v=15';
import { buildSeries, buildTiles, drawChart, chartHeight, euro, GROUPS, SPLITS, KINDS, PERIODS, DEFAULT_CHARTS, monthShort, TIME_GROUPS } from './charts.js?v=15';

/* ------------------------------------------------------------------ state */

const CACHE_KEY = `${STORAGE_PREFIX}.cache`;
const CHARTS_KEY = `${STORAGE_PREFIX}.charts`;
const VIEWS = ['overview', 'entries', 'charts', 'plans'];

/** Πληρωμές with no filter: the selected month, everything in it. */
function cleanFilter(extra = {}) {
  return { q: '', category: '', payer: '', scope: 'month', cats: null, from: '', to: '', source: '', ...extra };
}

const state = {
  settings: loadSettings(),
  data: null,
  month: null,
  view: 'overview',
  loading: false,
  lastFetch: 0,
  entryFilter: cleanFilter(),
  plansDirty: null, // set by the Πλάνα screen: () => true while it has changes that are not saved
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

/** What a chart shows, ignoring its title and layout: two charts with the same key are the same chart. */
function chartKey(c) {
  const cats = [...(c.categories || [])].sort().join('|');
  if (c.kind === 'tiles') return `tiles#${cats}`;
  return [c.kind, c.groupBy, c.splitBy || 'none', String(c.period), c.cumulative ? 1 : 0, cats].join('#');
}
/** Keeps the first of any charts that show exactly the same thing. */
function withoutDuplicates(charts) {
  const seen = new Set();
  return charts.filter((c) => (seen.has(chartKey(c)) ? false : seen.add(chartKey(c))));
}

function loadCharts() {
  try {
    const c = JSON.parse(localStorage.getItem(CHARTS_KEY));
    if (Array.isArray(c) && c.length) return withoutDuplicates(c);
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
const TOAST_ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};
/** A small note in the top-right corner (top of the screen on phones). It goes away on its own or with ✕. */
function toast(msg, isError = false) {
  const t = $('#toast');
  t.className = `toast${isError ? ' error' : ''}`;
  t.innerHTML = `<span class="toast-icon">${isError ? TOAST_ICON.error : TOAST_ICON.ok}</span><span class="toast-msg"></span><button type="button" class="toast-x" aria-label="Κλείσιμο">${TOAST_ICON.close}</button>`;
  $('.toast-msg', t).textContent = msg;
  $('.toast-x', t).addEventListener('click', hideToast);
  t.hidden = false;
  // As a popover it shows above open dialogs too (where supported).
  try { if (t.showPopover && !t.matches(':popover-open')) t.showPopover(); } catch { /* not supported */ }
  requestAnimationFrame(() => t.classList.add('in'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, isError ? 6000 : 3200);
}
function hideToast() {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.classList.remove('in');
  toastTimer = setTimeout(() => {
    t.hidden = true;
    try { if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); } catch { /* not supported */ }
  }, 200);
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
      categoryInfo: body.categoryInfo,
      payers: body.payers,
      updatedAt: body.updatedAt,
    };
    state.lastFetch = Date.now();
    saveCache();
    if (!state.month) state.month = defaultMonth(state.data);
    // Don't redraw over plan changes that are not saved yet; the new data shows once they are saved or dropped.
    if (!(state.plansDirty && state.plansDirty())) renderAll();
  } catch (err) {
    if (handleAuthError(err)) return;
    if (!quiet || !state.data) toast(err.message, true);
    if (!state.data) renderAll();
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
    $('#main').classList.remove('stale');
  }
}

function configured() {
  if (usesSupabase()) return supa.signedIn();
  return !!(state.settings.url && state.settings.key);
}

/** Signed out or not allowed in: forget this device's data and show the sign-in screen. */
function handleAuthError(err) {
  if (!(err instanceof ApiError) || !['login-required', 'no-access'].includes(err.code)) return false;
  if (err.code === 'no-access') supa.signOut();
  forgetData();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  renderAll();
  toast(err.message, true);
  return true;
}

function forgetData() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  state.data = null;
  state.month = null;
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
    $('#main').innerHTML = `<div class="empty">${state.loading ? (usesSupabase() ? 'Φόρτωση…' : 'Φόρτωση από το Google Sheet…') : 'Δεν ήταν δυνατή η φόρτωση. Πάτα ανανέωση ή έλεγξε τις Ρυθμίσεις.'}</div>`;
    return;
  }
  renderMonthPicker();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
  $('#updated').textContent = state.data.updatedAt
    ? `Ενημέρωση ${new Date(state.data.updatedAt).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  destroyCharts();
  state.plansDirty = null;
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

async function setMonth(m) {
  if (m === state.month || !(await leavePlans())) return renderMonthPicker();
  state.month = m;
  // A chart's date range no longer applies: show the chosen month.
  if (state.entryFilter.scope === 'range') state.entryFilter = cleanFilter();
  renderAll();
}

/* -------- setup -------- */

function settingsFieldsHtml() {
  if (usesSupabase()) {
    return `<label class="lbl">Λογαριασμός</label><p id="s-account">Συνδεδεμένος ως <b>${esc(supa.userEmail())}</b></p>`;
  }
  return `
    <label class="lbl" for="s-url">Διεύθυνση του Google script (τελειώνει σε /exec)</label>
    <input class="field" id="s-url" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.settings.url || '')}">
    <label class="lbl" for="s-key">Μυστικό κλειδί</label>
    <input class="field" id="s-key" type="password" autocomplete="off" value="${esc(state.settings.key || '')}">`;
}

function renderSetup() {
  if (usesSupabase()) return renderLogin();
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

/* -------- sign in by email (Supabase) -------- */

const LOGIN_EMAIL_KEY = `${STORAGE_PREFIX}.loginEmail`;

function renderLogin() {
  let email = '';
  try { email = localStorage.getItem(LOGIN_EMAIL_KEY) || ''; } catch { /* ignore */ }
  $('#main').innerHTML = `
    <div class="setup card">
      <h1>Σύνδεση</h1>
      <form id="login-form" novalidate>
        <p class="muted">Γράψε το email σου και θα σου έρθει ένα link σύνδεσης.</p>
        <label class="lbl" for="l-email">Email</label>
        <input class="field" id="l-email" type="email" inputmode="email" autocomplete="email" value="${esc(email)}" required>
        <div class="err" id="login-err" hidden></div>
        <div class="row-actions"><button class="btn primary" type="submit" id="login-send">Στείλε μου link</button></div>
      </form>
      <form id="code-form" novalidate hidden>
        <p class="muted">Στείλαμε email στο <b id="l-sent-to"></b>. Άνοιξέ το και πάτα το link σύνδεσης.</p>
        <p class="small muted">Αν το email έχει και κωδικό, μπορείς να τον γράψεις εδώ.</p>
        <label class="lbl" for="l-code">Κωδικός</label>
        <input class="field amount-input" id="l-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
        <div class="err" id="code-err" hidden></div>
        <div class="row-actions">
          <button class="btn" type="button" id="login-back">Άλλο email</button>
          <span class="spacer"></span>
          <button class="btn primary" type="submit" id="code-send">Σύνδεση</button>
        </div>
      </form>
      <p class="note">Μένεις συνδεδεμένος σε αυτή τη συσκευή μέχρι να πατήσεις Αποσύνδεση. Μπαίνουν μόνο τα email που έχουν πρόσβαση.</p>
    </div>`;
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = label; };
  const fail = (el, msg) => { el.textContent = msg; el.hidden = false; };
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    const value = $('#l-email').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return fail(err, 'Γράψε ένα σωστό email.');
    const btn = $('#login-send');
    busy(btn, true, 'Αποστολή…');
    try {
      await supa.sendCode(value);
      try { localStorage.setItem(LOGIN_EMAIL_KEY, value); } catch { /* ignore */ }
      $('#l-sent-to').textContent = value;
      $('#login-form').hidden = true;
      $('#code-form').hidden = false;
      $('#l-code').focus();
    } catch (e) {
      fail(err, e.message);
    } finally {
      busy(btn, false, 'Στείλε μου link');
    }
  });
  $('#login-back').addEventListener('click', () => {
    $('#code-form').hidden = true;
    $('#login-form').hidden = false;
  });
  $('#code-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#code-err');
    err.hidden = true;
    const code = $('#l-code').value.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(code)) return fail(err, 'Ο κωδικός έχει μόνο αριθμούς (6 ψηφία ή περισσότερα).');
    const btn = $('#code-send');
    busy(btn, true, 'Έλεγχος…');
    try {
      await supa.verifyCode($('#l-sent-to').textContent, code);
      renderAll();
      await fetchData();
    } catch (e) {
      fail(err, e.message);
      busy(btn, false, 'Σύνδεση');
    }
  });
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
      state.entryFilter = cleanFilter({ category: el.dataset.category });
      go_('entries');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  });
}

/* -------- entries -------- */

/** Whether a payment shows in Πληρωμές with filter f. */
function entryMatches(e, f) {
  const q = looseText(f.q);
  if (f.scope === 'range' ? e.date < f.from || e.date > f.to : f.scope !== 'all' && monthOf(e.date) !== state.month) return false;
  if (f.cats ? !f.cats.includes(e.category) : f.category && e.category !== f.category) return false;
  if (f.payer && e.payer !== f.payer) return false;
  return !q || looseText(`${e.description} ${e.comments} ${e.category}`).includes(q);
}

function renderEntries() {
  const f = state.entryFilter;
  const d = state.data;
  const list = d.entries
    .filter((e) => entryMatches(e, f))
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const total = list.reduce((s, e) => s + e.amount, 0);

  let html = '';
  let lastDate = '';
  for (const e of list) {
    if (e.date !== lastDate) {
      const dayTotal = list.filter((x) => x.date === e.date).reduce((s, x) => s + x.amount, 0);
      const dt = new Date(`${e.date}T12:00:00`);
      html += `<div class="day-head"><span>${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}${f.scope !== 'month' ? ` ${dt.getFullYear()}` : ''}</span><span class="num">${euro(dayTotal)}</span></div>`;
      lastDate = e.date;
    }
    const sub = [e.description, e.payer, e.comments].filter(Boolean).map(esc).join(' · ');
    html += `<button class="entry" data-id="${esc(e.id)}"><span class="t">${esc(e.category)}</span><span class="a">${euro(e.amount)}</span><span class="s">${sub || '&nbsp;'}</span></button>`;
  }

  const catOptions = [...d.categories];
  if (f.category && !catOptions.includes(f.category)) catOptions.push(f.category);
  $('#main').innerHTML = `
    ${f.source ? `
    <div class="drill-bar">
      <button class="btn" id="drill-back">← Γραφήματα</button>
      <span class="drill-src">${esc(f.source)}</span>
      <button class="btn" id="drill-clear">Καθαρισμός</button>
    </div>` : ''}
    <div class="filters">
      <input id="ef-q" type="search" placeholder="Αναζήτηση" value="${esc(f.q)}">
      <select id="ef-cat"><option value="">Όλες οι κατηγορίες</option>${f.cats ? `<option value="__multi" selected>${f.cats.length} κατηγορίες</option>` : ''}${catOptions.map((c) => `<option ${!f.cats && c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="ef-payer"><option value="">Όλοι</option>${d.payers.map((p) => `<option ${p === f.payer ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="ef-scope"><option value="month">${monthLong(state.month)}</option>${f.scope === 'range' ? `<option value="range" selected>${dateRangeLabel(f.from, f.to)}</option>` : ''}<option value="all" ${f.scope === 'all' ? 'selected' : ''}>Όλοι οι μήνες</option></select>
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
  $('#ef-cat').addEventListener('change', (ev) => { state.entryFilter.cats = null; upd('category')(ev); });
  $('#drill-back')?.addEventListener('click', () => go_('charts'));
  $('#drill-clear')?.addEventListener('click', () => {
    state.entryFilter = cleanFilter();
    renderEntries();
  });
  $('#ef-payer').addEventListener('change', upd('payer'));
  $('#ef-scope').addEventListener('change', upd('scope'));
  document.querySelectorAll('.entry').forEach((el) =>
    el.addEventListener('click', () => openEntry(state.data.entries.find((e) => e.id === el.dataset.id))),
  );
}

/** '2026-10-01', '2026-12-31' → '1/10 – 31/12/2026'. */
function dateRangeLabel(from, to) {
  const f = from.split('-').map(Number);
  const t = to.split('-').map(Number);
  if (from === to) return `${f[2]}/${f[1]}/${f[0]}`;
  return `${f[2]}/${f[1]}${f[0] !== t[0] ? `/${f[0]}` : ''} – ${t[2]}/${t[1]}/${t[0]}`;
}

/** Opens Πληρωμές with the payments behind a chart column, slice or card. */
function drillTo(filter, source) {
  const cats = filter.categories || [];
  state.entryFilter = {
    q: filter.q || '',
    category: cats.length === 1 ? cats[0] : '',
    cats: cats.length > 1 ? cats : null,
    payer: filter.payer || '',
    scope: 'range',
    from: filter.from,
    to: filter.to,
    source,
  };
  go_('entries');
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
    // The payment you just saved should be on screen: drop a filter that would hide it.
    if (!entryMatches(entry, state.entryFilter)) state.entryFilter = cleanFilter();
    renderAll();
    toast(editing ? 'Η πληρωμή άλλαξε' : `Καταχωρίστηκε: ${euro(entry.amount)} · ${entry.category}`);
    fetchData({ quiet: true });
  } catch (e) {
    if (handleAuthError(e)) return;
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Αποθήκευση';
  }
}

async function deleteEntry() {
  const e = state.editingEntry;
  if (!e) return;
  const sure = await ask({
    title: 'Διαγραφή πληρωμής;',
    text: `${euro(e.amount)} · ${e.category}${e.description ? ` · ${e.description}` : ''} (${e.date.split('-').reverse().join('/')})`,
    ok: 'Διαγραφή',
    danger: true,
  });
  if (!sure) return;
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
    if (handleAuthError(err)) return;
    $('#entry-err').textContent = err.message;
    $('#entry-err').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* -------- charts -------- */

function sparkline(points) {
  const max = Math.max(...points.map((p) => p.value), 1);
  const w = 120, h = 32, bw = w / points.length;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${points
    .map((p, i) => {
      const bh = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * (h - 2));
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" class="${i === points.length - 1 ? 'now' : ''}"/>`;
    })
    .join('')}</svg>`;
}

function tilesHtml(tiles) {
  return `<div class="cat-tiles">${tiles
    .map((t, i) => {
      const pct = t.plan ? Math.min(100, (t.paid / t.plan) * 100) : 0;
      const vsAvg = t.avg ? Math.round(((t.paid - t.avg) / t.avg) * 100) : null;
      const isCurrent = state.month === monthOf(todayIso());
      return `
      <button class="cat-tile tile-link ${t.status}" data-i="${i}">
        <span class="ct-name">${esc(t.category)}</span>
        <span class="ct-paid num">${euro(t.paid)}</span>
        <span class="ct-plan">${t.plan === null ? 'χωρίς πλάνο' : `από ${euro(t.plan)} πλάνο${t.paid > t.plan ? ` · +${euro(Math.round((t.paid - t.plan) * 100) / 100)}` : ''}`}</span>
        ${t.plan ? `<span class="ct-bar"><span style="width:${pct.toFixed(0)}%"></span></span>` : ''}
        <span class="ct-avg">${t.avg === null ? 'Δεν υπάρχουν προηγούμενοι μήνες ακόμα' : `Μ.ό. ${t.months} ${t.months === 1 ? 'μήνα' : 'μηνών'}: ${euro(t.avg)}${vsAvg === null ? '' : ` · ${vsAvg > 0 ? '▲' : vsAvg < 0 ? '▼' : ''} ${Math.abs(vsAvg)}%`}${isCurrent ? ' (μέχρι σήμερα)' : ''}`}</span>
        ${t.spark.length > 1 ? sparkline(t.spark) : ''}
        <span class="ct-spark-lbl">${t.spark.length > 1 ? `${monthShort(t.spark[0].month)} – ${monthShort(t.spark[t.spark.length - 1].month)}` : ''}</span>
      </button>`;
    })
    .join('')}</div>`;
}

function destroyCharts() {
  state.chartInstances.forEach((c) => c.destroy());
  state.chartInstances = [];
}

function chartSubtitle(cfg) {
  if (cfg.kind === 'tiles') return `${monthLong(state.month)} · σε σύγκριση με τον μέσο όρο 3 μηνών${state.chartPayer ? ` · ${state.chartPayer}` : ''}`;
  const period = cfg.period === 'month' ? monthLong(state.month) : `${PERIODS[cfg.period]} έως ${monthShort(state.month)}`;
  const cats = cfg.categories && cfg.categories.length ? ` · ${cfg.categories.length} κατηγορίες` : '';
  return `${period}${cats}${state.chartPayer ? ` · ${state.chartPayer}` : ''}`;
}

// "of that month", "for that month"… per grouping, for the hint under each chart.
const HINT_OF = { category: 'εκείνης της κατηγορίας', payer: 'εκείνου του προσώπου', type: 'εκείνου του είδους (πάγια ή επιπλέον)', day: 'εκείνης της μέρας', month: 'εκείνου του μήνα', quarter: 'εκείνου του τριμήνου', half: 'εκείνου του εξαμήνου', year: 'εκείνης της χρονιάς' };
const HINT_FOR = { category: 'σε εκείνη την κατηγορία', payer: 'από εκείνο το πρόσωπο', type: 'σε εκείνο το είδος', day: 'εκείνη τη μέρα', month: 'εκείνον τον μήνα', quarter: 'εκείνο το τρίμηνο', half: 'εκείνο το εξάμηνο', year: 'εκείνη τη χρονιά' };
const HINT_SPLIT = { category: ['μια κατηγορία', 'αυτής της κατηγορίας'], payer: ['ένα πρόσωπο', 'αυτού του προσώπου'], type: ['ένα είδος (πάγια ή επιπλέον)', 'αυτού του είδους'] };

/** One line under a chart that says what to tap and what it opens. */
function chartHint(cfg, built, table = false) {
  const g = cfg.groupBy;
  const split = built.series.length > 1 ? HINT_SPLIT[cfg.splitBy] : null;
  if (table) return `Πάτα σε μια γραμμή του πίνακα για να δεις τις πληρωμές ${HINT_OF[g]}.`;
  if (cfg.kind === 'doughnut') return `Πάτα σε ένα κομμάτι για να δεις τις πληρωμές ${HINT_OF[g]}.`;
  if (cfg.kind === 'line') {
    // A running total: say the list has only that day's (or month's) payments, not everything up to it.
    const only = cfg.cumulative && TIME_GROUPS.has(g) ? 'μόνο ' : '';
    if (split) return `Κάθε γραμμή είναι ${split[0]}. Πάτα σε ένα σημείο της για να δεις ${only}τις πληρωμές ${split[1]} ${HINT_FOR[g]}.`;
    return `Πάτα σε ένα σημείο της γραμμής για να δεις ${only}τις πληρωμές ${HINT_OF[g]}.`;
  }
  const bar = g === 'category' ? 'μπάρας' : 'στήλης';
  if (split) return `Κάθε χρώμα είναι ${split[0]}. Πάτα σε ένα χρώμα μιας ${bar} για να δεις τις πληρωμές ${split[1]} ${HINT_FOR[g]}.`;
  return `Πάτα σε μια ${g === 'category' ? 'μπάρα' : 'στήλη'} για να δεις τις πληρωμές ${HINT_OF[g]}.`;
}

function tableHtml(built) {
  const cols = built.series.map((s) => s.label);
  if (built.reference) cols.push(built.reference.label);
  const rows = built.labels.map((l, i) => {
    const vals = built.series.map((s) => s.values[i]);
    if (built.reference) vals.push(built.reference.values[i]);
    return `<tr data-i="${i}" class="drill-row"><td>${esc(l)}</td>${vals.map((v) => `<td>${v === null ? "—" : euro(v)}</td>`).join('')}</tr>`;
  });
  return `<div class="table-scroll"><table class="chart-table"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderCharts() {
  const d = state.data;
  $('#main').innerHTML = `
    <div class="filters">
      <select id="cf-payer" aria-label="Ποιος πλήρωσε"><option value="">Όλοι</option>${d.payers.map((p) => `<option ${p === state.chartPayer ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <button class="btn" id="chart-analysis">+ Ανάλυση κατηγοριών</button>
      <button class="btn" id="chart-add">+ Νέο γράφημα</button>
      <button class="btn" id="chart-reset">Επαναφορά</button>
    </div>
    <div class="chart-grid" id="chart-grid"></div>`;
  $('#cf-payer').addEventListener('change', (e) => { state.chartPayer = e.target.value; renderAll(); });
  $('#chart-add').addEventListener('click', () => openChart(null));
  $('#chart-analysis').addEventListener('click', openAnalysis);
  $('#chart-reset').addEventListener('click', async () => {
    if (!(await ask({ title: 'Επαναφορά γραφημάτων;', text: 'Τα γραφήματα σε αυτή τη συσκευή γυρίζουν στα αρχικά. Οι αλλαγές σου σε αυτά χάνονται.', ok: 'Επαναφορά' }))) return;
    state.charts = structuredClone(DEFAULT_CHARTS);
    saveCharts();
    renderAll();
  });

  const grid = $('#chart-grid');
  const ctx = { month: state.month, payer: state.chartPayer, today: todayIso() };
  state.charts.forEach((cfg, i) => {
    const built = cfg.kind === 'tiles' ? null : buildSeries(d, cfg, ctx);
    const card = document.createElement('section');
    card.className = `card chart-card${cfg.wide ? ' wide' : ''}`;
    card.innerHTML = `
      <div class="card-head">
        <h2>${esc(cfg.title || GROUPS[cfg.groupBy])}<div class="sub">${esc(chartSubtitle(cfg))}</div></h2>
        <div class="chart-tools">
          ${built ? `<button class="icon-btn" data-act="table" title="Πίνακας / γράφημα" aria-label="Πίνακας">${cfg.showTable ? ICON.chart : ICON.table}</button>` : ''}
          <button class="icon-btn" data-act="up" title="Πάνω" aria-label="Μετακίνηση πάνω" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="icon-btn" data-act="down" title="Κάτω" aria-label="Μετακίνηση κάτω" ${i === state.charts.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="icon-btn" data-act="edit" title="Ρυθμίσεις γραφήματος" aria-label="Επεξεργασία">${ICON.edit}</button>
        </div>
      </div>
      <div class="chart-body"></div>`;
    grid.appendChild(card);
    const body = $('.chart-body', card);
    const title = cfg.title || GROUPS[cfg.groupBy];
    if (!built) {
      const tiles = buildTiles(d, cfg, ctx);
      body.innerHTML = tiles.length
        ? `${tilesHtml(tiles)}<p class="chart-hint">Πάτα σε μια κάρτα για να δεις τις πληρωμές της κατηγορίας αυτόν τον μήνα.</p>`
        : '<div class="chart-empty">Δεν υπάρχουν πληρωμές αυτόν τον μήνα.</div>';
      body.querySelectorAll('.tile-link').forEach((el) =>
        el.addEventListener('click', () => drillTo(tiles[Number(el.dataset.i)].drill, `${title} · ${tiles[Number(el.dataset.i)].category} · ${monthLong(state.month)}`)),
      );
    } else if (built.empty) {
      body.innerHTML = '<div class="chart-empty">Δεν υπάρχουν πληρωμές για αυτή την περίοδο.</div>';
    } else if (cfg.showTable || !window.Chart) {
      body.innerHTML = tableHtml(built) + `<p class="chart-hint">${chartHint(cfg, built, true)}</p>` + (window.Chart ? '' : '<p class="small muted">Τα γραφήματα δεν φορτώθηκαν. Εμφανίζεται πίνακας.</p>');
      body.querySelectorAll('tr[data-i]').forEach((tr) =>
        tr.addEventListener('click', () => drillTo(built.drill(Number(tr.dataset.i)), `${title} · ${built.labels[Number(tr.dataset.i)]}`)),
      );
    } else {
      body.innerHTML = `<div class="chart-box" style="height:${chartHeight(cfg, built)}px"><canvas role="img" aria-label="${esc(cfg.title)}"></canvas></div>
        <p class="chart-hint">${chartHint(cfg, built)}</p>`;
      state.chartInstances.push(drawChart($('canvas', body), cfg, built, d, (filter, label) => drillTo(filter, `${title} · ${label}`)));
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
  $('#chart-err').hidden = true;
  syncChartForm();
  const chosen = new Set(c.categories || []);
  $('#c-cats').innerHTML = state.data.categories
    .map((cat) => `<label><input type="checkbox" value="${esc(cat)}" ${chosen.has(cat) ? 'checked' : ''}>${esc(cat)}</label>`)
    .join('');
  $('#chart-dlg').showModal();
}

/** Cards ("tiles") only use the categories, so hide the fields that don't apply to them. */
function syncChartForm() {
  const tiles = $('#c-kind').value === 'tiles';
  for (const id of ['#c-group', '#c-period', '#c-split', '#c-plan', '#c-cum']) $(id).closest('div, label').hidden = tiles;
  $('#c-cats-lbl').textContent = tiles ? 'Κατηγορίες (καμία επιλογή = οι 4 με τα περισσότερα έξοδα του μήνα)' : 'Κατηγορίες (καμία επιλογή = όλες)';
}

// Categories worth a closer look, picked by name the first time: super market, personal, other / one-off.
const ANALYSIS_HINTS = ['super', 'σουπερ', 'προσωπ', 'λοιπ', 'εκτακτ'];

function openAnalysis() {
  $('#a-cats').innerHTML = state.data.categories
    .map((cat) => {
      const on = ANALYSIS_HINTS.some((h) => looseText(cat).includes(looseText(h)));
      return `<label><input type="checkbox" value="${esc(cat)}" ${on ? 'checked' : ''}>${esc(cat)}</label>`;
    })
    .join('');
  $('#a-err').hidden = true;
  $('#analysis-dlg').showModal();
}

function saveAnalysis(ev) {
  ev.preventDefault();
  const categories = [...document.querySelectorAll('#a-cats input:checked')].map((i) => i.value);
  if (!categories.length) {
    $('#a-err').textContent = 'Διάλεξε τουλάχιστον μία κατηγορία.';
    $('#a-err').hidden = false;
    return;
  }
  const name = categories.length === 1 ? categories[0] : `${categories.length} κατηγορίες`;
  const base = { categories, showPlan: true, cumulative: false, wide: true, splitBy: 'none' };
  const id = Date.now();
  const wanted = [
    { ...base, id: `c${id}a`, title: `${name}: με μια ματιά`, kind: 'tiles', groupBy: 'category', period: 'month' },
    { ...base, id: `c${id}b`, title: `${name}: πορεία του μήνα`, kind: 'line', groupBy: 'day', period: 'month', cumulative: true, wide: false },
    { ...base, id: `c${id}c`, title: `${name}: ανά μήνα`, kind: 'bar', groupBy: 'month', splitBy: categories.length > 1 ? 'category' : 'none', period: '12', wide: false },
  ];
  // A chart that already shows the same thing is not made again.
  const have = new Set(state.charts.map(chartKey));
  const added = wanted.filter((c) => !have.has(chartKey(c)));
  if (!added.length) {
    $('#a-err').textContent = 'Αυτά τα γραφήματα υπάρχουν ήδη για αυτές τις κατηγορίες.';
    $('#a-err').hidden = false;
    return;
  }
  // New analysis goes on top, so it is the first thing you see.
  state.charts = added.concat(state.charts);
  saveCharts();
  $('#analysis-dlg').close();
  renderAll();
  window.scrollTo({ top: 0 });
  const skipped = wanted.length - added.length;
  toast(skipped
    ? `Προστέθηκ${added.length === 1 ? 'ε 1 γράφημα' : `αν ${added.length} γραφήματα`}. ${skipped === 1 ? 'Το άλλο υπήρχε' : `Τα άλλα ${skipped} υπήρχαν`} ήδη.`
    : `Προστέθηκαν ${added.length} γραφήματα στην αρχή της σελίδας`);
}

// Titles made by "Ανάλυση κατηγοριών" end in ": ανά μήνα"; they follow a change of grouping.
const PER = { month: 'ανά μήνα', quarter: 'ανά τρίμηνο', half: 'ανά εξάμηνο', year: 'ανά έτος' };
function retitle(title, groupBy) {
  const m = /^(.*): ανά (μήνα|τρίμηνο|εξάμηνο|έτος)$/.exec(title);
  return m && PER[groupBy] ? `${m[1]}: ${PER[groupBy]}` : title;
}

function saveChart(ev) {
  ev.preventDefault();
  const groupBy = $('#c-group').value;
  const next = {
    title: retitle($('#c-title').value.trim(), groupBy) || GROUPS[groupBy],
    groupBy,
    kind: $('#c-kind').value,
    period: $('#c-period').value,
    splitBy: $('#c-split').value,
    showPlan: $('#c-plan').checked,
    cumulative: $('#c-cum').checked,
    wide: $('#c-wide').checked,
    categories: [...document.querySelectorAll('#c-cats input:checked')].map((i) => i.value),
  };
  const same = state.charts.find((c) => c !== state.editingChart && chartKey(c) === chartKey(next));
  if (same) {
    $('#chart-err').textContent = `Υπάρχει ήδη γράφημα με αυτές τις ρυθμίσεις: «${same.title || GROUPS[same.groupBy]}».`;
    $('#chart-err').hidden = false;
    return;
  }
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
    if (!usesSupabase()) {
      $('#main').innerHTML = `<div class="card empty">Ο μήνας ${monthLong(m)} δεν υπάρχει στο «Ιστορικό και πλάνα». Πρόσθεσέ τον στο Google Sheet.</div>`;
      return;
    }
    $('#main').innerHTML = `
      <div class="card empty">
        <p>Ο μήνας ${monthLong(m)} δεν έχει ακόμα ταβάνι και πλάνα.</p>
        <p class="small muted">Θα αντιγραφούν από τον προηγούμενο μήνα και μετά μπορείς να τα αλλάξεις.</p>
        <div class="err" id="plans-err" hidden></div>
        <button class="btn primary" type="button" id="add-month">Δημιουργία μήνα</button>
      </div>`;
    $('#add-month').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await call(state.settings, 'addMonth', { month: m });
        toast(`Ο ${monthLong(m)} δημιουργήθηκε`);
        await fetchData();
      } catch (e) {
        if (handleAuthError(e)) return;
        $('#plans-err').textContent = e.message;
        $('#plans-err').hidden = false;
        ev.target.disabled = false;
      }
    });
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
    </form>
    ${usesSupabase() && !d.entries.some((e) => monthOf(e.date) === m) ? `
    <div class="card">
      <p class="small muted">Ο ${monthLong(m)} δεν έχει πληρωμές, οπότε μπορεί να διαγραφεί αν δημιουργήθηκε κατά λάθος.</p>
      <div class="err" id="delete-month-err" hidden></div>
      <button class="btn danger" type="button" id="delete-month">Διαγραφή του μήνα</button>
    </div>` : ''}`;
  $('#delete-month')?.addEventListener('click', async (ev) => {
    if (!(await ask({ title: `Διαγραφή του ${monthLong(m)};`, text: 'Σβήνονται το ταβάνι και τα πλάνα του μήνα. Μπορείς να τον ξαναδημιουργήσεις αργότερα από τον προηγούμενο.', ok: 'Διαγραφή', danger: true }))) return;
    ev.target.disabled = true;
    try {
      await call(state.settings, 'deleteMonth', { month: m });
      toast(`Ο ${monthLong(m)} διαγράφηκε`);
      await fetchData();
    } catch (e) {
      if (handleAuthError(e)) return;
      $('#delete-month-err').textContent = e.message;
      $('#delete-month-err').hidden = false;
      ev.target.disabled = false;
    }
  });

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
  let saving = false;
  state.plansDirty = () => { if (saving) return false; const ch = changes(); return ch.rows.length > 0 || ch.monthChanged; };
  // Saves and resolves true, or shows the error and resolves false.
  const save = async () => {
    const err = $('#plans-err');
    err.hidden = true;
    const ch = changes();
    const forward = $('#p-forward').checked;
    const bad = ch.rows.find((r) => r.plan !== null && (!isFinite(r.plan) || r.plan < 0));
    if (bad) { err.textContent = `Μη έγκυρο ποσό στο «${bad.category}».`; err.hidden = false; return false; }
    if (ch.monthChanged && (!isFinite(ch.cap) || ch.cap < 0 || !(ch.warn > 0 && ch.warn <= 1))) {
      err.textContent = 'Έλεγξε το ταβάνι και την ειδοποίηση (1 έως 100%).';
      err.hidden = false;
      return false;
    }
    const btn = $('#plans-save');
    btn.disabled = true;
    btn.textContent = 'Αποθήκευση…';
    try {
      if (ch.monthChanged) await call(state.settings, 'setMonth', { month: m, cap: ch.cap, warn: ch.warn, forward });
      for (const r of ch.rows) await call(state.settings, 'setPlan', { month: m, category: r.category, type: r.type, plan: r.plan, forward });
      saving = true;
      toast('Τα πλάνα αποθηκεύτηκαν');
      await fetchData();
      return true;
    } catch (e) {
      if (handleAuthError(e)) return false;
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Αποθήκευση αλλαγών';
      return false;
    }
  };
  state.savePlans = save;
  form.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
}

/* ------------------------------------------------------------ ask dialog */

/**
 * The site's own confirmation window (instead of the browser's confirm/prompt).
 * Resolves true when the person presses the main button.
 */
function ask({ title, text = '', ok = 'OK', danger = false, cancel = true, value = null, alt = null, cancelText = 'Άκυρο' }) {
  const dlg = $('#ask-dlg');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-text').hidden = !text;
  const field = $('#ask-value');
  field.hidden = value === null;
  field.value = value ?? '';
  const okBtn = $('#ask-ok');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger-fill', danger);
  $('#ask-cancel').hidden = !cancel;
  $('#ask-cancel').textContent = cancelText;
  // A third choice: then it resolves 'ok', 'alt' or '' (cancel, Esc) instead of true/false.
  $('#ask-alt').hidden = !alt;
  $('#ask-alt').textContent = alt || '';
  dlg.returnValue = '';
  dlg.showModal();
  if (value !== null) { field.focus(); field.select(); } else okBtn.focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(alt ? dlg.returnValue : dlg.returnValue === 'ok'), { once: true }));
}

/* ---------------------------------------------------------------- settings */

function applyTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === t)));
}

/* -------- connect another device (QR / link) -------- */

// Bundled in the repo (MIT), so it doesn't depend on an outside CDN.
const QR_LIB = 'js/vendor/qrcode-1.4.4.js';
const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

function connectLink() {
  // With Supabase each person signs in with their own email, so the link is just the site.
  if (usesSupabase()) return `${location.origin}${location.pathname}`;
  const payload = b64url(JSON.stringify({ u: state.settings.url, k: state.settings.key }));
  return `${location.origin}${location.pathname}#connect=${payload}`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.qrcode) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Δεν φορτώθηκε το QR code. Χρησιμοποίησε την αντιγραφή link.'));
    document.head.appendChild(el);
  });
}

async function showShare() {
  const box = $('#share-box');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  const link = connectLink();
  $('#share-send').hidden = !navigator.share;
  try {
    await loadScript(QR_LIB);
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (e) {
    $('#qr').hidden = true;
    toast(e.message, true);
  }
}

/** Opening a #connect=… link saves the connection on this device. Returns true if it handled one. */
function consumeConnectLink() {
  const m = /^#connect=([\w-]+)$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', `${location.pathname}#overview`);
  try {
    const { u, k } = JSON.parse(unb64url(m[1]));
    if (!u || !k) throw new Error();
    state.settings = { ...state.settings, url: u, key: k };
    saveSettings(state.settings);
    toast('Η συσκευή συνδέθηκε');
  } catch {
    toast('Το link σύνδεσης δεν είναι σωστό.', true);
  }
  return true;
}

function openSettings() {
  $('#settings-fields').innerHTML = settingsFieldsHtml();
  $('#settings-err').hidden = true;
  $('#logout').hidden = !configured();
  $('#share-section').hidden = !configured();
  $('#share-box').hidden = true;
  $('#manage-section').hidden = !(usesSupabase() && state.data);
  $('#export-section').hidden = !state.data;
  $('#share-note').textContent = usesSupabase()
    ? 'Σκάναρε με την κάμερα του άλλου κινητού, ή στείλε το link. Ανοίγει τη σελίδα, και εκεί συνδέεσαι με το δικό σου email.'
    : 'Σκάναρε με την κάμερα του άλλου κινητού, ή στείλε το link. Το link περιέχει το κλειδί, οπότε στείλ\' το μόνο σε δικά σας άτομα.';
  $('#logout').textContent = usesSupabase() ? 'Αποσύνδεση' : 'Αποσύνδεση από αυτή τη συσκευή';
  applyTheme();
  $('#settings-dlg').showModal();
}

/* -------- categories and people (Supabase) -------- */

const MICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19M1 1l22 22"/></svg>',
  show: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

function categoryInfo() {
  return state.data.categoryInfo || state.data.categories.map((name) => ({ name, hidden: false }));
}

function renderManage() {
  const cats = categoryInfo();
  const iconBtn = (act, i, icon, label, disabled = false) =>
    `<button type="button" class="icon-btn" data-act="${act}" data-i="${i}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}>${icon}</button>`;
  $('#cat-list').innerHTML = cats
    .map((c, i) => `
      <div class="manage-row${c.hidden ? ' hidden-cat' : ''}">
        <input class="field" data-kind="cat" data-i="${i}" value="${esc(c.name)}" aria-label="Όνομα κατηγορίας" autocomplete="off">
        ${iconBtn('cat-up', i, MICON.up, 'Πάνω', i === 0)}
        ${iconBtn('cat-down', i, MICON.down, 'Κάτω', i === cats.length - 1)}
        ${c.hidden ? iconBtn('cat-show', i, MICON.show, 'Εμφάνιση') : iconBtn('cat-hide', i, MICON.hide, 'Απόκρυψη')}
      </div>`)
    .join('');
  const payers = state.data.payers;
  $('#payer-list').innerHTML = payers
    .map((p, i) => `
      <div class="manage-row">
        <input class="field" data-kind="payer" data-i="${i}" value="${esc(p)}" aria-label="Όνομα" autocomplete="off">
        ${iconBtn('payer-up', i, MICON.up, 'Πάνω', i === 0)}
        ${iconBtn('payer-down', i, MICON.down, 'Κάτω', i === payers.length - 1)}
        ${iconBtn('payer-delete', i, MICON.trash, 'Διαγραφή')}
      </div>`)
    .join('');
}

/** Runs one change, then reloads the data and redraws the list. Returns true if it worked. */
async function manageCall(action, payload, done) {
  const body = $('#manage-body');
  const err = $('#manage-err');
  err.hidden = true;
  body.classList.add('busy');
  try {
    await call(state.settings, action, payload);
    await fetchData({ quiet: true });
    if (done) toast(done);
    return true;
  } catch (e) {
    if (handleAuthError(e)) return false;
    err.textContent = e.message;
    err.hidden = false;
    return false;
  } finally {
    body.classList.remove('busy');
    if (state.data) renderManage();
  }
}

const moved = (list, i, by) => {
  const out = [...list];
  [out[i], out[i + by]] = [out[i + by], out[i]];
  return out;
};

function openManage() {
  $('#manage-err').hidden = true;
  renderManage();
  $('#settings-dlg').close();
  $('#manage-dlg').showModal();
}

function initManage() {
  $('#open-manage').addEventListener('click', openManage);
  $('#manage-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i);
    const cats = categoryInfo();
    const names = cats.map((c) => c.name);
    const payers = state.data.payers;
    switch (b.dataset.act) {
      case 'cat-up': return manageCall('orderCategories', { names: moved(names, i, -1) });
      case 'cat-down': return manageCall('orderCategories', { names: moved(names, i, 1) });
      case 'cat-hide': return manageCall('updateCategory', { category: names[i], hidden: true }, `Η «${names[i]}» κρύφτηκε`);
      case 'cat-show': return manageCall('updateCategory', { category: names[i], hidden: false }, `Η «${names[i]}» εμφανίζεται ξανά`);
      case 'payer-up': return manageCall('orderPayers', { names: moved(payers, i, -1) });
      case 'payer-down': return manageCall('orderPayers', { names: moved(payers, i, 1) });
      case 'payer-delete':
        return ask({ title: `Διαγραφή του «${payers[i]}»;`, text: 'Θα φύγει από το «Ποιος πλήρωσε».', ok: 'Διαγραφή', danger: true })
          .then((sure) => sure && manageCall('deletePayer', { payer: payers[i] }, `Το «${payers[i]}» διαγράφηκε`));
    }
  });
  // Renaming: type over the name, then leave the field or press Enter.
  $('#manage-body').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-kind]');
    if (!input) return;
    const i = Number(input.dataset.i);
    const value = input.value.trim();
    if (input.dataset.kind === 'cat') {
      const old = categoryInfo()[i].name;
      if (value === old) return;
      manageCall('updateCategory', { category: old, newName: value }, `Μετονομάστηκε σε «${value}»`);
    } else {
      const old = state.data.payers[i];
      if (value === old) return;
      manageCall('renamePayer', { payer: old, newName: value }, `Μετονομάστηκε σε «${value}»`);
    }
  });
  $('#manage-body').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-kind]')) { e.preventDefault(); e.target.blur(); }
  });
  $('#cat-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#cat-new-name').value.trim();
    const raw = $('#cat-new-plan').value.trim();
    const plan = raw === '' ? null : parseAmount(raw);
    if (!name) return showManageError('Γράψε όνομα κατηγορίας.');
    if (plan !== null && (!isFinite(plan) || plan < 0)) return showManageError('Μη έγκυρο ποσό πλάνου.');
    const ok = await manageCall('addCategory', { category: name, type: $('#cat-new-type').value, plan }, `Προστέθηκε η «${name}»`);
    if (ok) { $('#cat-new-name').value = ''; $('#cat-new-plan').value = ''; }
  });
  $('#payer-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#payer-new-name').value.trim();
    if (!name) return showManageError('Γράψε όνομα.');
    const ok = await manageCall('addPayer', { payer: name }, `Προστέθηκε το «${name}»`);
    if (ok) $('#payer-new-name').value = '';
  });
}

function showManageError(msg) {
  $('#manage-err').textContent = msg;
  $('#manage-err').hidden = false;
}

/* -------- export -------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const today = () => new Date().toISOString().slice(0, 10);

// Greek Excel expects ";" between columns and a decimal comma; the BOM makes it read UTF-8.
function exportCsv() {
  const cell = (v) => {
    const t = String(v ?? '');
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [['Ημερομηνία', 'Κατηγορία', 'Περιγραφή', 'Ποσό', 'Ποιος πλήρωσε', 'Σχόλια']];
  for (const e of [...state.data.entries].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([e.date, e.category, e.description, String(e.amount).replace('.', ','), e.payer, e.comments]);
  }
  download(`plirwmes-${today()}.csv`, '\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
}

function exportJson() {
  const { entries, months, plans, categories, categoryInfo: info, payers } = state.data;
  const backup = { exportedAt: new Date().toISOString(), entries, months, plans, categories, categoryInfo: info, payers };
  download(`budget-backup-${today()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

/* ------------------------------------------------------------------ routing */

/** A tab was pressed: Πληρωμές opens clean, and unsaved plan changes are not lost silently. */
async function openTab(view) {
  if (view === state.view && view !== 'entries') return;
  if (!(await leavePlans())) return;
  if (view === 'entries') state.entryFilter = cleanFilter();
  go_(view);
}

/**
 * Before leaving Πλάνα (tab, month, refresh) with changes that are not saved:
 * asks to save, drop them or stay. Resolves true when it is fine to leave.
 */
async function leavePlans() {
  if (state.view !== 'plans' || !state.plansDirty || !state.plansDirty()) return true;
  const choice = await ask({ title: 'Δεν αποθηκεύτηκαν οι αλλαγές', text: 'Άλλαξες πλάνα σε αυτόν τον μήνα. Τι να γίνει με τις αλλαγές;', ok: 'Αποθήκευση', alt: 'Απόρριψη', cancelText: 'Μένω εδώ' });
  if (choice === 'alt') { state.plansDirty = null; return true; }
  if (choice !== 'ok') return false;
  return state.savePlans ? state.savePlans() : false;
}

function go_(view) {
  state.view = VIEWS.includes(view) ? view : 'overview';
  if (location.hash !== `#${state.view}`) history.replaceState(null, '', `#${state.view}`);
  window.scrollTo(0, 0);
  renderAll();
}

/* -------------------------------------------------------------------- init */

function consumeSignInLink() {
  if (!usesSupabase()) return;
  try {
    if (supa.consumeRedirect()) { forgetData(); toast('Συνδέθηκες'); }
  } catch (e) {
    toast(e.message, true);
  }
}

function init() {
  applyTheme();
  consumeSignInLink();
  if (!usesSupabase()) consumeConnectLink();
  state.view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openTab(t.dataset.view)));
  window.addEventListener('hashchange', () => {
    if (!usesSupabase() && consumeConnectLink()) {
      state.data = null;
      state.month = null;
      renderAll();
      fetchData();
      return;
    }
    go_(location.hash.slice(1));
  });
  $('#share-connect').addEventListener('click', showShare);
  initManage();
  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-json').addEventListener('click', exportJson);
  $('#share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(connectLink());
      toast('Το link αντιγράφηκε');
    } catch {
      ask({ title: 'Αντίγραψε το link', text: 'Πάτα παρατεταμένα στο link και διάλεξε Αντιγραφή.', value: connectLink(), ok: 'Κλείσιμο', cancel: false });
    }
  });
  $('#share-send').addEventListener('click', () =>
    navigator.share({ title: 'Οικογενειακά έξοδα', text: 'Σύνδεση στα οικογενειακά έξοδα', url: connectLink() }).catch(() => {}),
  );
  $('#month').addEventListener('change', (e) => setMonth(e.target.value));
  $('#prev-month').addEventListener('click', () => setMonth(addMonths(state.month, -1)));
  $('#next-month').addEventListener('click', () => setMonth(addMonths(state.month, 1)));
  $('#refresh').addEventListener('click', async () => { if (await leavePlans()) { state.plansDirty = null; fetchData(); } });
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
  $('#c-kind').addEventListener('change', syncChartForm);
  $('#analysis-form').addEventListener('submit', saveAnalysis);
  $('#chart-delete').addEventListener('click', async () => {
    if (!state.editingChart) return;
    if (!(await ask({ title: 'Διαγραφή γραφήματος;', text: `«${state.editingChart.title}» θα φύγει από αυτή τη συσκευή.`, ok: 'Διαγραφή', danger: true }))) return;
    state.charts = state.charts.filter((c) => c !== state.editingChart);
    saveCharts();
    $('#chart-dlg').close();
    renderAll();
  });

  $('#settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (usesSupabase()) return $('#settings-dlg').close();
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
  $('#logout').addEventListener('click', async () => {
    const sure = await ask({
      title: 'Αποσύνδεση;',
      text: usesSupabase()
        ? 'Αυτή η συσκευή θα αποσυνδεθεί. Τα δεδομένα μένουν στη βάση· για να ξαναμπείς θα ζητήσεις νέο link με το email σου.'
        : 'Θα σβηστούν από αυτή τη συσκευή η σύνδεση με το Google Sheet και τα αποθηκευμένα δεδομένα.',
      ok: 'Αποσύνδεση',
      danger: true,
    });
    if (!sure) return;
    const theme = state.settings.theme;
    state.settings = { theme };
    saveSettings(state.settings);
    if (usesSupabase()) supa.signOut();
    forgetData();
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
