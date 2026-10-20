// Same maths as the formulas in the sheet's "Έλεγχος μήνα" tab.
// Pure functions: no DOM, so they can be tested with Node.

export const FIXED = 'Πάγιο';
export const EXTRA = 'Επιπλέον';

export const STATUS = {
  OVER: 'over',        // ΥΠΕΡΒΑΣΗ
  NEAR: 'near',        // ΚΟΝΤΑ ΣΤΟ ΟΡΙΟ
  OK: 'ok',            // ΕΝΤΟΣ ΠΛΑΝΟΥ / ΚΑΤΩ ΑΠΟ ΤΟ ΟΡΙΟ
  PAID: 'paid',        // plan fully paid, nothing over
  NOPLAN: 'noplan',    // ΧΩΡΙΣ ΠΛΑΝΟ
};

export const monthOf = (isoDate) => String(isoDate).slice(0, 7);

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Category status, as in column G of "Έλεγχος μήνα". */
export function categoryStatus(plan, paid, warn) {
  if (plan === null || plan === undefined) return STATUS.NOPLAN;
  if (paid > plan + 1e-9) return STATUS.OVER;
  if (plan > 0 && Math.abs(paid - plan) < 0.005) return STATUS.PAID;
  if (plan > 0 && paid >= plan * warn) return STATUS.NEAR;
  return STATUS.OK;
}

/** Whole-month status, as in E7/E8 of "Έλεγχος μήνα". */
export function capStatus(amount, cap, warn) {
  if (amount > cap) return STATUS.OVER;
  if (amount >= cap * warn) return STATUS.NEAR;
  return STATUS.OK;
}

/**
 * Builds the month overview.
 * data: { entries, months, plans, categories }
 */
export function monthSummary(data, month) {
  const limits = data.months.find((m) => m.month === month) || { cap: 0, warn: 0.8, missing: true };
  const cap = limits.cap;
  const warn = limits.warn;

  const inMonth = data.entries.filter((e) => monthOf(e.date) === month);
  const spent = round2(inMonth.reduce((s, e) => s + e.amount, 0));

  const paidBy = new Map();
  for (const e of inMonth) paidBy.set(e.category, (paidBy.get(e.category) || 0) + e.amount);

  const planRows = data.plans.filter((p) => p.month === month);
  const rows = data.categories.map((category) => {
    const pr = planRows.filter((p) => p.category === category);
    const type = pr.some((p) => p.type === FIXED) ? FIXED : EXTRA;
    const withPlan = pr.filter((p) => p.plan !== null);
    const plan = withPlan.length ? round2(withPlan.reduce((s, p) => s + p.plan, 0)) : null;
    const paid = round2(paidBy.get(category) || 0);
    return {
      category,
      type,
      plan,
      paid,
      remaining: plan === null ? null : round2(Math.max(0, plan - paid)),
      over: plan === null ? null : round2(Math.max(0, paid - plan)),
      status: categoryStatus(plan, paid, warn),
    };
  });

  const sum = (key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));
  const planTotal = sum('plan');
  const fixedRemaining = round2(rows.filter((r) => r.type === FIXED).reduce((s, r) => s + (r.remaining || 0), 0));
  const spentPlusFixed = round2(spent + fixedRemaining);

  // Payments whose category is not in the list still count in "spent".
  const known = new Set(data.categories);
  const uncategorised = round2(inMonth.filter((e) => !known.has(e.category)).reduce((s, e) => s + e.amount, 0));

  return {
    month,
    cap,
    warn,
    limitsMissing: !!limits.missing,
    spent,
    fixedRemaining,
    spentPlusFixed,
    available: round2(cap - spentPlusFixed),
    overActual: round2(Math.max(0, spent - cap)),
    planOverCap: round2(Math.max(0, planTotal - cap)),
    missingPlans: rows.filter((r) => r.plan === null).length,
    statusActual: capStatus(spent, cap, warn),
    statusWithFixed: capStatus(spentPlusFixed, cap, warn),
    totals: {
      plan: planTotal,
      paid: sum('paid'),
      remaining: sum('remaining'),
      over: sum('over'),
      status: categoryStatus(planTotal, sum('paid'), warn),
    },
    uncategorised,
    rows,
    count: inMonth.length,
  };
}

/** The month that contains today, or the closest month the sheet knows about. */
export function defaultMonth(data, today = new Date()) {
  const now = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const known = data.months.map((m) => m.month).sort();
  if (!known.length || known.includes(now)) return now;
  if (now < known[0]) return known[0];
  return known[known.length - 1];
}
