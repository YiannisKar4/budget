// Custom charts: turns a chart definition into series, then draws it with Chart.js.
import { monthOf, addMonths, monthRange, FIXED, EXTRA } from './calc.js?v=12';

export const GROUPS = {
  category: 'Κατηγορία',
  payer: 'Ποιος πλήρωσε',
  type: 'Πάγιο / Επιπλέον',
  day: 'Ημέρα',
  month: 'Μήνας',
  quarter: 'Τρίμηνο',
  half: 'Εξάμηνο',
  year: 'Έτος',
};
// Groupings along time: they get the limit or plan as a tick per column.
export const TIME_GROUPS = new Set(['day', 'month', 'quarter', 'half', 'year']);
export const SPLITS = { none: 'Χωρίς ανάλυση', payer: 'Ποιος πλήρωσε', type: 'Πάγιο / Επιπλέον', category: 'Κατηγορία (κορυφαίες 7)' };
export const KINDS = { bar: 'Στήλες', line: 'Γραμμή', doughnut: 'Πίτα (ντόνατ)', tiles: 'Κάρτες: με μια ματιά ανά κατηγορία' };
export const PERIODS = {
  month: 'Επιλεγμένος μήνας',
  3: 'Τελευταίοι 3 μήνες',
  6: 'Τελευταίοι 6 μήνες',
  12: 'Τελευταίοι 12 μήνες',
  24: 'Τελευταίοι 24 μήνες',
  ytd: 'Από την αρχή της χρονιάς',
  all: 'Όλο το διάστημα',
};

export const DEFAULT_CHARTS = [
  { id: 'c1', title: 'Έξοδα ανά κατηγορία', groupBy: 'category', splitBy: 'none', kind: 'bar', period: 'month', showPlan: true, cumulative: false, categories: [] },
  { id: 'c2', title: 'Πορεία του μήνα', groupBy: 'day', splitBy: 'none', kind: 'line', period: 'month', showPlan: true, cumulative: true, categories: [] },
  { id: 'c3', title: 'Ποιος πλήρωσε', groupBy: 'payer', splitBy: 'none', kind: 'doughnut', period: 'month', showPlan: false, cumulative: false, categories: [] },
  { id: 'c4', title: 'Έξοδα ανά μήνα', groupBy: 'month', splitBy: 'type', kind: 'bar', period: '12', showPlan: true, cumulative: false, categories: [] },
];

const OTHER = 'Άλλα';
const round2 = (n) => Math.round(n * 100) / 100;

function windowMonths(data, cfg, month) {
  if (cfg.period === 'month') return [month];
  if (cfg.period === 'ytd') return monthRange(`${month.slice(0, 4)}-01`, month);
  if (cfg.period === 'all') {
    const all = data.entries.map((e) => monthOf(e.date)).concat(month).sort();
    return monthRange(all[0], month);
  }
  // Don't reach back before the first month that has any data.
  const n = Number(cfg.period) || 1;
  const first = data.entries.map((e) => monthOf(e.date)).concat(data.months.map((m) => m.month), month).sort()[0];
  const start = addMonths(month, -(n - 1));
  return monthRange(start < first ? first : start, month);
}

function typeLookup(data) {
  const map = new Map();
  for (const p of data.plans) if (p.type === FIXED) map.set(`${p.month}|${p.category}`, FIXED);
  return (month, category) => map.get(`${month}|${category}`) || EXTRA;
}

/**
 * Returns { labels, series: [{ key, label, values }], reference: { label, values } | null, empty }
 * ctx: { month, payer } — the filters shown above all charts.
 */
export function buildSeries(data, cfg, ctx) {
  const months = windowMonths(data, cfg, ctx.month);
  const monthSet = new Set(months);
  const cats = cfg.categories && cfg.categories.length ? new Set(cfg.categories) : null;
  const typeOf = typeLookup(data);

  const entries = data.entries.filter(
    (e) => monthSet.has(monthOf(e.date)) && (!ctx.payer || e.payer === ctx.payer) && (!cats || cats.has(e.category)),
  );

  // Keys for the main axis.
  let keys;
  let labelOf = (k) => k;
  const keyOf = {
    category: (e) => e.category,
    payer: (e) => e.payer || '—',
    type: (e) => typeOf(monthOf(e.date), e.category),
    month: (e) => monthOf(e.date),
    day: (e) => e.date,
    quarter: (e) => periodKey(monthOf(e.date), 'quarter'),
    half: (e) => periodKey(monthOf(e.date), 'half'),
    year: (e) => periodKey(monthOf(e.date), 'year'),
  }[cfg.groupBy];

  if (['quarter', 'half', 'year'].includes(cfg.groupBy)) {
    keys = [...new Set(months.map((m) => periodKey(m, cfg.groupBy)))];
    labelOf = (k) => periodLabel(k);
  } else if (cfg.groupBy === 'category') {
    const extra = [...new Set(entries.map((e) => e.category))].filter((c) => !data.categories.includes(c));
    keys = data.categories.filter((c) => !cats || cats.has(c)).concat(extra);
  } else if (cfg.groupBy === 'payer') {
    const extra = [...new Set(entries.map(keyOf))].filter((p) => !data.payers.includes(p));
    keys = data.payers.filter((p) => !ctx.payer || p === ctx.payer).concat(extra);
  } else if (cfg.groupBy === 'type') {
    keys = [FIXED, EXTRA];
  } else if (cfg.groupBy === 'month') {
    keys = months;
    labelOf = monthShort;
  } else {
    keys = [];
    const last = lastDay(months[months.length - 1]);
    for (let d = `${months[0]}-01`; d <= last; d = nextDay(d)) keys.push(d);
    labelOf = (k) => `${Number(k.slice(8))}/${Number(k.slice(5, 7))}`;
  }

  // Secondary split (stacked series).
  let splitKeys = ['__all'];
  let splitOf = () => '__all';
  if (cfg.kind !== 'doughnut' && cfg.splitBy && cfg.splitBy !== 'none' && cfg.splitBy !== cfg.groupBy) {
    if (cfg.splitBy === 'payer') {
      splitOf = (e) => e.payer || '—';
      splitKeys = data.payers.filter((p) => !ctx.payer || p === ctx.payer);
    } else if (cfg.splitBy === 'type') {
      splitOf = (e) => typeOf(monthOf(e.date), e.category);
      splitKeys = [FIXED, EXTRA];
    } else if (cfg.splitBy === 'category') {
      const totals = new Map();
      for (const e of entries) totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
      const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([c]) => c);
      const topSet = new Set(top);
      splitOf = (e) => (topSet.has(e.category) ? e.category : OTHER);
      splitKeys = totals.size > 7 ? [...top, OTHER] : top;
    }
  }

  const idx = new Map(keys.map((k, i) => [k, i]));
  const series = splitKeys.map((s) => ({ key: s, label: s === '__all' ? 'Πληρωμένα' : s, values: keys.map(() => 0) }));
  const sIdx = new Map(splitKeys.map((s, i) => [s, i]));
  for (const e of entries) {
    const i = idx.get(keyOf(e));
    const j = sIdx.get(splitOf(e));
    if (i === undefined || j === undefined) continue;
    series[j].values[i] += e.amount;
  }
  for (const s of series) s.values = s.values.map(round2);

  if (cfg.cumulative && (cfg.groupBy === 'day' || cfg.groupBy === 'month')) {
    for (const s of series) {
      let run = 0;
      s.values = s.values.map((v) => round2((run += v)));
    }
    // A running total stops at today instead of drawing a flat line into the future.
    if (cfg.groupBy === 'day' && ctx.today) {
      for (const s of series) s.values = s.values.map((v, i) => (keys[i] > ctx.today ? null : v));
    }
  }

  // Reference values: plan per category/type, or the monthly limit over time.
  let reference = null;
  if (cfg.showPlan) {
    if (cfg.groupBy === 'category' || cfg.groupBy === 'type') {
      const values = keys.map((k) =>
        round2(
          data.plans
            .filter((p) => monthSet.has(p.month) && p.plan !== null && (cfg.groupBy === 'category' ? p.category === k : typeOf(p.month, p.category) === k && (!cats || cats.has(p.category))))
            .reduce((s, p) => s + p.plan, 0),
        ),
      );
      reference = { label: 'Πλάνο', values };
    } else if (['month', 'quarter', 'half', 'year'].includes(cfg.groupBy)) {
      // Whole budget: the limit. Some categories only: the sum of their plans.
      const inKey = (m, k) => monthSet.has(m) && (cfg.groupBy === 'month' ? m === k : periodKey(m, cfg.groupBy) === k);
      reference = cats
        ? { label: 'Πλάνο', values: keys.map((k) => round2(data.plans.filter((p) => cats.has(p.category) && p.plan !== null && inKey(p.month, k)).reduce((s, p) => s + p.plan, 0))) }
        : { label: 'Ταβάνι', values: keys.map((k) => round2(data.months.filter((x) => inKey(x.month, k)).reduce((s, x) => s + x.cap, 0))) };
      if (reference.values.every((v) => !v)) reference = null;
    } else if (cfg.groupBy === 'day' && cfg.cumulative && months.length === 1) {
      // Running total for one month: against the limit, or the plan of the chosen categories.
      const total = cats
        ? round2(data.plans.filter((p) => p.month === months[0] && cats.has(p.category) && p.plan !== null).reduce((s, p) => s + p.plan, 0))
        : (data.months.find((x) => x.month === months[0]) || { cap: 0 }).cap;
      reference = total ? { label: cats ? 'Πλάνο' : 'Ταβάνι', values: keys.map(() => total) } : null;
    }
  }

  // Doughnuts read best with few slices: keep the top 5, fold the rest into "Άλλα".
  let labels = keys.map(labelOf);
  let outKeys = [...keys];
  if (cfg.kind === 'doughnut') {
    const triples = keys.map((k, i) => [k, labels[i], series[0].values[i]]).filter(([, , v]) => v > 0);
    triples.sort((a, b) => b[2] - a[2]);
    if (triples.length > 6) {
      const rest = round2(triples.slice(5).reduce((s, [, , v]) => s + v, 0));
      triples.splice(5, triples.length, [OTHER, OTHER, rest]);
    }
    outKeys = triples.map(([k]) => k);
    labels = triples.map(([, l]) => l);
    series[0].values = triples.map(([, , v]) => v);
    reference = null;
  } else if (cfg.groupBy === 'category') {
    // Hide categories with nothing paid and nothing planned.
    const keep = keys.map((_, i) => series.some((s) => s.values[i] > 0) || (reference && reference.values[i] > 0));
    labels = labels.filter((_, i) => keep[i]);
    outKeys = outKeys.filter((_, i) => keep[i]);
    for (const s of series) s.values = s.values.filter((_, i) => keep[i]);
    if (reference) reference.values = reference.values.filter((_, i) => keep[i]);
  }

  const empty = series.every((s) => s.values.every((v) => !v));
  const drill = (i, seriesKey) => drillFilter(cfg, ctx, months, outKeys[i], seriesKey);
  return { labels, series, reference, empty, months, drill };
}

/**
 * What the Πληρωμές list should show for one column, slice or segment of a chart:
 * { from, to, categories?, payer?, q? }. Columns that mix things it cannot filter
 * (e.g. Πάγιο/Επιπλέον, "Άλλα") fall back to the chart's own categories and dates.
 */
function drillFilter(cfg, ctx, months, key, seriesKey) {
  const out = { from: `${months[0]}-01`, to: lastDay(months[months.length - 1]), categories: cfg.categories && cfg.categories.length ? [...cfg.categories] : [], payer: ctx.payer || '', q: '' };
  const apply = (dim, k) => {
    if (k === undefined || k === null || k === '__all' || k === OTHER) return;
    if (dim === 'category') out.categories = [k];
    else if (dim === 'payer' && k !== '—') out.payer = k;
    else if (dim === 'day') { out.from = k; out.to = k; }
    else if (dim === 'month') { out.from = `${k}-01`; out.to = lastDay(k); }
    else if (['quarter', 'half', 'year'].includes(dim)) {
      const inside = months.filter((m) => periodKey(m, dim) === k);
      if (inside.length) { out.from = `${inside[0]}-01`; out.to = lastDay(inside[inside.length - 1]); }
    }
  };
  apply(cfg.groupBy, key);
  if (cfg.kind !== 'doughnut' && cfg.splitBy && cfg.splitBy !== 'none') apply(cfg.splitBy, seriesKey);
  return out;
}

/**
 * "At a glance" cards: one per category, for the selected month.
 * Each has the month's spending, its plan, the average of the 3 months before
 * (only months that have any payments in the data) and the last 6 months for a sparkline.
 */
export function buildTiles(data, cfg, ctx) {
  const month = ctx.month;
  const firstMonth = data.entries.map((e) => monthOf(e.date)).sort()[0] || month;
  const spark = monthRange(addMonths(month, -5), month).filter((m) => m >= firstMonth);
  const before = monthRange(addMonths(month, -3), addMonths(month, -1)).filter((m) => m >= firstMonth);
  const paidIn = (cat, m) => round2(data.entries.filter((e) => e.category === cat && monthOf(e.date) === m && (!ctx.payer || e.payer === ctx.payer)).reduce((s, e) => s + e.amount, 0));
  let cats = cfg.categories && cfg.categories.length ? cfg.categories : null;
  if (!cats) {
    // No choice made: the categories with the most spending this month.
    const totals = new Map();
    for (const e of data.entries) if (monthOf(e.date) === month) totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
    cats = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);
  }
  return cats.map((cat) => {
    const paid = paidIn(cat, month);
    const planRow = data.plans.find((p) => p.month === month && p.category === cat);
    const plan = planRow ? planRow.plan : null;
    const avg = before.length ? round2(before.reduce((s, m) => s + paidIn(cat, m), 0) / before.length) : null;
    const status = plan === null ? 'noplan' : paid > plan ? 'over' : paid >= plan * 0.8 ? 'near' : 'ok';
    return {
      category: cat,
      paid,
      plan,
      avg,
      months: before.length,
      status,
      spark: spark.map((m) => ({ month: m, value: paidIn(cat, m) })),
      drill: { from: `${month}-01`, to: lastDay(month), categories: [cat], payer: ctx.payer || '', q: '' },
    };
  });
}

/* ------------------------------------------------------------------ render */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function seriesColor(cfg, key, i, data) {
  // Colour follows the entity: payers and types keep their slot whatever the filter.
  if (key === '__all') return css('--series-1');
  if (key === OTHER) return css('--text-muted');
  if (cfg.splitBy === 'type' || cfg.groupBy === 'type') return css(key === FIXED ? '--series-1' : '--series-2');
  if (cfg.splitBy === 'payer') {
    const p = data.payers.indexOf(key);
    return css(`--series-${(p >= 0 ? p : i) % 8 + 1}`);
  }
  return css(`--series-${(i % 8) + 1}`);
}

export const euro = (v) =>
  new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);

export function drawChart(canvas, cfg, built, data, onPick) {
  const Chart = window.Chart;
  const grid = css('--grid');
  const ink2 = css('--text-secondary');
  const muted = css('--text-muted');
  const surface = css('--surface-1');
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.color = ink2;

  const horizontal = cfg.kind === 'bar' && cfg.groupBy === 'category';
  const stacked = cfg.kind === 'bar' && built.series.length > 1;
  let datasets;

  if (cfg.kind === 'doughnut') {
    const colors = built.labels.map((l, i) => {
      if (l === OTHER) return muted;
      if (cfg.groupBy === 'payer') return css(`--series-${(Math.max(0, data.payers.indexOf(l)) % 8) + 1}`);
      if (cfg.groupBy === 'type') return css(l === FIXED ? '--series-1' : '--series-2');
      return css(`--series-${(i % 8) + 1}`);
    });
    datasets = [{ label: 'Πληρωμένα', data: built.series[0].values, backgroundColor: colors, borderColor: surface, borderWidth: 2, hoverOffset: 4 }];
  } else {
    datasets = built.series.map((s, i) => {
      const color = seriesColor(cfg, s.key, i, data);
      return cfg.kind === 'line'
        ? { type: 'line', label: s.label, data: s.values, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2 }
        : { type: 'bar', label: s.label, data: s.values, backgroundColor: color, borderColor: surface, borderWidth: stacked ? (horizontal ? { right: 2 } : { top: 2 }) : 0, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, stack: stacked ? 'paid' : undefined };
    });
    if (built.reference) {
      const isPlan = built.reference.label === 'Πλάνο';
      const tick = TIME_GROUPS.has(cfg.groupBy) && cfg.groupBy !== 'day';
      datasets.push(
        isPlan && cfg.kind === 'bar' && !tick
          ? { type: 'bar', label: 'Πλάνο', data: built.reference.values, backgroundColor: css('--plan-fill'), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, stack: stacked ? 'plan' : undefined }
          : tick
            ? // One horizontal tick per month, drawn across the column, so the limit shows even for a single month.
              { type: 'line', label: built.reference.label, data: built.reference.values, showLine: false, order: -1, pointStyle: 'line', pointRadius: 24, pointHoverRadius: 24, pointBorderWidth: 3, pointHoverBorderWidth: 3, borderColor: css('--text-primary'), backgroundColor: css('--text-primary') }
            : { type: 'line', label: built.reference.label, data: built.reference.values, borderColor: css('--text-primary'), borderWidth: 1.5, pointRadius: 0, pointStyle: 'line', fill: false },
      );
    }
  }

  const valueAxis = {
    beginAtZero: true,
    stacked,
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    ticks: { callback: (v) => euro(v), maxTicksLimit: 6, padding: 6, color: muted },
  };
  const catAxis = {
    stacked,
    grid: { display: false },
    border: { color: css('--axis') },
    ticks: { color: ink2, autoSkip: true, maxRotation: 0, padding: 4 },
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: cfg.kind === 'doughnut' ? 'nearest' : 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    plugins: {
      legend: {
        display: datasets.length > 1 || cfg.kind === 'doughnut',
        position: 'bottom',
        labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, padding: 14, color: ink2, sort: (a, b) => a.datasetIndex - b.datasetIndex },
      },
      tooltip: {
        backgroundColor: css('--tooltip-bg'),
        titleColor: css('--tooltip-ink'),
        bodyColor: css('--tooltip-ink'),
        padding: 10,
        cornerRadius: 8,
        boxPadding: 4,
        callbacks: {
          label: (c) =>
            ` ${cfg.kind === 'doughnut' ? c.label : c.dataset.label}: ${euro(cfg.kind === 'doughnut' ? c.parsed : horizontal ? c.parsed.x : c.parsed.y)}`,
        },
      },
    },
  };
  if (onPick) {
    // Tap a column, slice or segment to see its payments. Plan/limit marks are not payments.
    const hit = (chart, evt) => {
      const exact = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false)
        .filter((el) => el.datasetIndex < built.series.length);
      if (exact.length) return exact[0];
      if (cfg.kind === 'doughnut') return null;
      const col = chart.getElementsAtEventForMode(evt, 'index', { intersect: false, axis: horizontal ? 'y' : 'x' }, false)
        .filter((el) => el.datasetIndex < built.series.length);
      return col.length ? { index: col[0].index, datasetIndex: built.series.length > 1 ? -1 : 0 } : null;
    };
    options.onClick = (evt, _els, chart) => {
      const el = hit(chart, evt);
      if (!el) return;
      const s = built.series[el.datasetIndex];
      const filter = built.drill(el.index, s ? s.key : undefined);
      // Run after Chart.js has finished with this click: opening the list destroys the chart.
      const label = s && built.series.length > 1 ? `${built.labels[el.index]} · ${s.label}` : built.labels[el.index];
      setTimeout(() => onPick(filter, label));
    };
    options.onHover = (evt, _els, chart) => {
      chart.canvas.style.cursor = hit(chart, evt) ? 'pointer' : 'default';
    };
  }
  if (cfg.kind === 'doughnut') {
    options.cutout = '62%';
  } else {
    options.indexAxis = horizontal ? 'y' : 'x';
    options.scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
  }

  return new Chart(canvas, { type: cfg.kind === 'doughnut' ? 'doughnut' : 'bar', data: { labels: built.labels, datasets }, options });
}

export function chartHeight(cfg, built) {
  if (cfg.kind === 'doughnut') return 260;
  if (cfg.kind === 'bar' && cfg.groupBy === 'category') return Math.max(160, built.labels.length * (cfg.showPlan ? 38 : 28) + 60);
  return 260;
}

/* ----------------------------------------------------------------- helpers */

/** '2026-10' → '2026-Q4' | '2026-H2' | '2026'. */
export function periodKey(month, unit) {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  if (unit === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`;
  if (unit === 'half') return `${y}-H${m <= 6 ? 1 : 2}`;
  return y;
}

function periodLabel(key) {
  const y = key.slice(2, 4);
  const q = /-Q(\d)$/.exec(key);
  if (q) return `${MONTHS_SHORT[(q[1] - 1) * 3]}–${MONTHS_SHORT[q[1] * 3 - 1]} ${y}`;
  const h = /-H(\d)$/.exec(key);
  if (h) return h[1] === '1' ? `Ιαν–Ιουν ${y}` : `Ιουλ–Δεκ ${y}`;
  return key;
}

const MONTHS_SHORT = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μάι', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];
export const monthShort = (m) => `${MONTHS_SHORT[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;

export function lastDay(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, '0')}`;
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
