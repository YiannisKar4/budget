// Our own dropdowns and calendar, in place of the phone's or browser's.
//
// Every <select> and <input type="date"> on the page gets a button that looks like the other
// fields and opens a list or a calendar in the site's colours. The real element stays in the page,
// invisible, and holds the value: the rest of the code reads and sets it as before, and a choice
// here fires the usual "input" and "change" events on it. Fields added later (filters, rows) are
// picked up on their own.

const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
const MONTHS_SHORT = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μαΐ', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];
const DAYS_SHORT = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'];
const WEEK_HEAD = ['Δε', 'Τρ', 'Τε', 'Πε', 'Πα', 'Σα', 'Κυ'];

const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ shared */

/** Calls fn whenever the code sets el.value (or selectedIndex) directly, which fires no event. */
function watchValue(el, props, fn) {
  for (const prop of props) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop);
    if (!desc || !desc.set) continue;
    Object.defineProperty(el, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); fn(); },
    });
  }
}

/** Builds the visible button and puts the real field, now invisible, inside the same box. */
function wrap(el, kind) {
  const box = document.createElement('span');
  box.className = `pk pk-${kind}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `pk-btn ${el.className}`.trim();
  btn.setAttribute('aria-haspopup', kind === 'dd' ? 'listbox' : 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const label = el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent.trim());
  if (label) btn.setAttribute('aria-label', label);
  btn.innerHTML = `<span class="pk-text"></span><span class="pk-icon">${kind === 'dd' ? ICON_CHEVRON : ICON_CAL}</span>`;
  el.before(box);
  box.append(btn, el);
  el.classList.add('pk-native');
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  // The code sometimes focuses the field (e.g. to show where a problem is): focus the button.
  el.focus = (opts) => btn.focus(opts);
  return { box, btn, text: btn.firstElementChild };
}

function fire(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

let open = null; // { pop, btn, close(focusBack) }

function closeOpen(focusBack = false) {
  if (open) open.close(focusBack);
}

/** Shows pop next to btn: below it when it fits, otherwise wherever there is more room. */
function place(pop, btn, minWidth) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const gap = 6;
  const margin = 8;
  // As wide as the longest choice (no wrapping when it fits), never narrower than the field.
  pop.style.width = 'max-content';
  const width = Math.min(Math.max(r.width, minWidth, pop.offsetWidth + 1), vw - margin * 2);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(margin, Math.min(r.left, vw - width - margin))}px`;
  pop.style.maxHeight = '';
  const natural = pop.scrollHeight;
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const down = natural <= below || below >= above;
  const room = Math.max(120, down ? below : above);
  pop.style.maxHeight = `${room}px`;
  const h = Math.min(natural, room);
  pop.style.top = `${down ? r.bottom + gap : r.top - gap - h}px`;
  pop.classList.toggle('up', !down);
}

function openPop(btn, pop, minWidth, onClose) {
  closeOpen();
  // Inside a window the list must sit in the same window, or it ends up behind it.
  (btn.closest('dialog') || document.body).append(pop);
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('pk-open');
  place(pop, btn, minWidth);
  const reposition = (e) => { if (!e || !pop.contains(e.target)) place(pop, btn, minWidth); };
  const outside = (e) => {
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    state.close(false);
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  document.addEventListener('pointerdown', outside, true);
  const state = {
    pop,
    btn,
    close(focusBack) {
      if (open !== state) return;
      open = null;
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', outside, true);
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('pk-open');
      onClose?.();
      if (focusBack) btn.focus({ preventScroll: true });
      if (reducedMotion()) { pop.remove(); return; }
      pop.classList.add('closing');
      setTimeout(() => pop.remove(), 120);
    },
  };
  open = state;
  return state;
}

// Esc closes the list or calendar only, not the window behind it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); closeOpen(true); }
}, true);
// A window closing takes its open list with it.
document.addEventListener('close', (e) => { if (open && e.target.contains?.(open.btn)) closeOpen(); }, true);

// A tap on a field's label opens our picker, not the phone's.
document.addEventListener('click', (e) => {
  const lbl = e.target.closest?.('label[for]');
  if (!lbl) return;
  const el = document.getElementById(lbl.htmlFor);
  if (!el || !el.classList.contains('pk-native')) return;
  e.preventDefault();
  const btn = el.parentElement.querySelector('.pk-btn');
  btn.focus();
  btn.click();
});

/* ------------------------------------------------------------------ dropdowns */

function enhanceSelect(sel) {
  // «Διάλεξε κατηγορία»: an empty first choice of a required field is only a prompt, not a choice.
  const isPrompt = (o) => !!o && sel.required && o.value === '' && o.index === 0;
  const { box, btn, text } = wrap(sel, 'dd');

  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    text.textContent = o ? o.textContent : '';
    btn.classList.toggle('pk-empty', isPrompt(o));
    btn.disabled = sel.disabled;
    box.hidden = sel.hidden;
  };
  watchValue(sel, ['value', 'selectedIndex'], sync);
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
  sel.addEventListener('change', sync);
  sync();

  const choose = (i) => {
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    closeOpen(true);
    if (changed) fire(sel);
  };

  const show = () => {
    if (open && open.btn === btn) { closeOpen(true); return; }
    const pop = document.createElement('div');
    pop.className = 'pk-pop pk-menu';
    pop.setAttribute('role', 'listbox');
    if (btn.getAttribute('aria-label')) pop.setAttribute('aria-label', btn.getAttribute('aria-label'));
    const items = [];
    [...sel.options].forEach((o, i) => {
      if (o.hidden || isPrompt(o)) return;
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'pk-opt';
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', String(i === sel.selectedIndex));
      it.disabled = o.disabled;
      it.dataset.i = i;
      it.innerHTML = `<span></span>${ICON_CHECK}`;
      it.firstChild.textContent = o.textContent;
      it.addEventListener('click', () => choose(i));
      pop.append(it);
      items.push(it);
    });
    pop.addEventListener('keydown', (e) => {
      const live = items.filter((x) => !x.disabled);
      const at = live.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = live[Math.min(at + 1, live.length - 1)];
      else if (e.key === 'ArrowUp') next = live[Math.max(at - 1, 0)];
      else if (e.key === 'Home') next = live[0];
      else if (e.key === 'End') next = live[live.length - 1];
      else if (e.key === 'Tab') { closeOpen(true); return; }
      else if (e.key.length === 1) {
        const k = e.key.toLowerCase();
        next = live.slice(at + 1).concat(live.slice(0, at + 1)).find((x) => x.textContent.trim().toLowerCase().startsWith(k));
      }
      if (next) { e.preventDefault(); next.focus(); }
    });
    openPop(btn, pop, 180);
    const current = pop.querySelector('[aria-selected="true"]') || items.find((x) => !x.disabled);
    if (current) {
      current.scrollIntoView({ block: 'center' });
      current.focus({ preventScroll: true });
    }
  };

  btn.addEventListener('click', show);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); }
  });
}

/* ------------------------------------------------------------------ dates */

/** «Πέμ 6 Νοε 2026», short enough for half a phone screen. */
export function dateLabel(value) {
  const d = parseIso(value);
  return d ? `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}` : '';
}

function enhanceDate(input) {
  const { btn, text } = wrap(input, 'dp');

  const sync = () => {
    text.textContent = dateLabel(input.value) || input.placeholder || 'Διάλεξε ημερομηνία';
    btn.classList.toggle('pk-empty', !input.value);
    btn.disabled = input.disabled;
  };
  watchValue(input, ['value', 'valueAsDate', 'valueAsNumber'], sync);
  new MutationObserver(sync).observe(input, { attributes: true });
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  sync();

  const show = () => {
    if (open && open.btn === btn) { closeOpen(true); return; }
    const today = iso(new Date());
    const picked = input.value;
    const start = parseIso(picked) || new Date();
    let view = new Date(start.getFullYear(), start.getMonth(), 1);
    let focusDay = picked || today;
    const min = input.min || '';
    const max = input.max || '';
    const allowed = (s) => (!min || s >= min) && (!max || s <= max);

    const pop = document.createElement('div');
    pop.className = 'pk-pop pk-cal';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', btn.getAttribute('aria-label') || 'Ημερομηνία');
    pop.innerHTML = `
      <div class="pk-cal-head">
        <button type="button" class="pk-nav" data-step="-1" aria-label="Προηγούμενος μήνας">${ICON_PREV}</button>
        <b class="pk-cal-title" aria-live="polite"></b>
        <button type="button" class="pk-nav" data-step="1" aria-label="Επόμενος μήνας">${ICON_NEXT}</button>
      </div>
      <div class="pk-week">${WEEK_HEAD.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="pk-days" role="grid"></div>
      <div class="pk-cal-foot">
        <button type="button" class="pk-quick" data-day="today">Σήμερα</button>
        <button type="button" class="pk-quick" data-day="yesterday">Χθες</button>
      </div>`;
    const grid = pop.querySelector('.pk-days');

    const draw = (dir = 0) => {
      pop.querySelector('.pk-cal-title').textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
      const first = new Date(view);
      const lead = (first.getDay() + 6) % 7; // Monday first
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(view.getFullYear(), view.getMonth(), 1 - lead + i);
        const s = iso(d);
        const cls = ['pk-day'];
        if (d.getMonth() !== view.getMonth()) cls.push('out');
        if (s === today) cls.push('today');
        cells.push(`<button type="button" class="${cls.join(' ')}" data-day="${s}" aria-label="${dateLabel(s)}" aria-pressed="${s === picked}" tabindex="${s === focusDay ? 0 : -1}" ${allowed(s) ? '' : 'disabled'}>${d.getDate()}</button>`);
      }
      // Six rows only when the month needs them, so short months are not padded with next month.
      const rows = Math.ceil((lead + new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()) / 7);
      grid.innerHTML = cells.slice(0, rows * 7).join('');
      if (dir && !reducedMotion()) {
        grid.classList.remove('slide-l', 'slide-r');
        void grid.offsetWidth;
        grid.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
      }
      if (open && open.pop === pop) place(pop, btn, 296);
    };

    const step = (n) => { view = new Date(view.getFullYear(), view.getMonth() + n, 1); draw(n); };
    const pick = (s) => {
      if (!allowed(s)) return;
      const changed = input.value !== s;
      input.value = s;
      closeOpen(true);
      if (changed) fire(input);
    };

    pop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.step) { step(Number(b.dataset.step)); return; }
      const day = b.dataset.day;
      if (day === 'today') pick(today);
      else if (day === 'yesterday') { const y = new Date(); y.setDate(y.getDate() - 1); pick(iso(y)); }
      else if (day) pick(day);
    });
    pop.addEventListener('keydown', (e) => {
      const b = e.target.closest('.pk-day');
      if (!b) return;
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (!(e.key in moves)) return;
      e.preventDefault();
      const d = parseIso(b.dataset.day);
      d.setDate(d.getDate() + moves[e.key]);
      focusDay = iso(d);
      if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) {
        const dir = d < view ? -1 : 1;
        view = new Date(d.getFullYear(), d.getMonth(), 1);
        draw(dir);
      }
      grid.querySelector(`[data-day="${focusDay}"]`)?.focus();
    });
    // Swipe sideways to change month, as on the phone's own calendar.
    let sx = null;
    let sy = null;
    grid.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    grid.addEventListener('touchend', (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });

    draw();
    openPop(btn, pop, 296);
    grid.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  };

  btn.addEventListener('click', show);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); show(); }
  });
}

/* ------------------------------------------------------------------ start */

function enhance(root) {
  if (root.nodeType !== 1) return;
  const found = root.matches('select, input[type="date"]') ? [root] : root.querySelectorAll('select, input[type="date"]');
  for (const el of found) {
    if (el.classList.contains('pk-native') || el.multiple || el.dataset.native !== undefined) continue;
    if (el.tagName === 'SELECT') enhanceSelect(el);
    else enhanceDate(el);
  }
}

export function startPickers() {
  enhance(document.body);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(enhance);
  }).observe(document.body, { childList: true, subtree: true });
}
