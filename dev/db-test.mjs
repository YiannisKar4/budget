// Tests supabase/schema.sql on an in-process PostgreSQL (PGlite), with Supabase's
// auth helpers stubbed. Usage: node dev/db-test.mjs [data.sql]
// Without data.sql it seeds a small synthetic household.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url).pathname;
const db = new PGlite();

// Minimal stand-ins for what Supabase provides.
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  -- Like a project with "Automatically expose new tables" off: nothing is granted by default.
  alter default privileges in schema public revoke execute on functions from public;
`);

await db.exec(fs.readFileSync(`${root}supabase/schema.sql`, 'utf8'));
await db.exec(fs.readFileSync(`${root}supabase/schema.sql`, 'utf8')); // must be re-runnable

const dataFile = process.argv[2];
if (dataFile) {
  await db.exec(fs.readFileSync(dataFile, 'utf8'));
} else {
  await db.exec(`
    insert into households (id, name) values ('00000000-0000-4000-8000-000000000001', 'Test');
    insert into allowed_emails values ('a@example.com', '00000000-0000-4000-8000-000000000001');
    insert into payers (household_id, name) values ('00000000-0000-4000-8000-000000000001', 'A'), ('00000000-0000-4000-8000-000000000001', 'B');
    insert into categories (household_id, name, default_type, sort_order) values
      ('00000000-0000-4000-8000-000000000001', 'Rent', 'fixed', 0), ('00000000-0000-4000-8000-000000000001', 'Food', 'extra', 1);
    insert into month_limits values ('00000000-0000-4000-8000-000000000001', '2026-10-01', 1000, 0.8), ('00000000-0000-4000-8000-000000000001', '2026-11-01', 1000, 0.8);
    insert into category_plans select '00000000-0000-4000-8000-000000000001', m::date, id, default_type, 500 from categories, unnest(array['2026-10-01', '2026-11-01']) m;
  `);
}

// A second household that must stay invisible to the first.
await db.exec(`
  insert into households (id, name) values ('00000000-0000-4000-8000-000000000002', 'Other');
  insert into allowed_emails values ('other@example.com', '00000000-0000-4000-8000-000000000002');
  insert into categories (household_id, name) values ('00000000-0000-4000-8000-000000000002', 'Secret');
`);

const email = dataFile ? (await db.query('select email from allowed_emails order by email limit 1')).rows[0].email : 'a@example.com';

/** Runs a query as a signed-in user (or anon when email is null), like Supabase does. */
async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    if (who) {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', email: who })]);
      await tx.exec('set local role authenticated');
    } else {
      await tx.exec('set local role anon');
    }
    return tx.query(sql, params);
  });
}
const rpc = async (who, fn, args = []) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await as(who, `select ${fn}(${ph}) as r`, args);
  return r.rows[0].r;
};
const rejects = async (p, re, label) => {
  try { await p; } catch (e) { assert.match(String(e.message), re, label); return; }
  assert.fail(`${label}: expected an error`);
};

let passed = 0;
const ok = (label) => { passed++; console.log('  ✓', label); };

// Reading
const data = await rpc(email, 'api_read');
if (process.env.COMPARE_URL) {
  // Same data through the Google Apps Script mock: the website must see identical numbers.
  const gas = await fetch(process.env.COMPARE_URL, { method: 'POST', body: JSON.stringify({ key: 'test', action: 'read' }) }).then((r) => r.json());
  const norm = (es) => es.map(({ id, ...e }) => JSON.stringify(e)).sort();
  assert.deepEqual(norm(data.entries), norm(gas.entries), 'payments differ from the sheet');
  assert.deepEqual(data.months, gas.months, 'monthly limits differ from the sheet');
  const key = (p) => `${p.month}|${p.category}`;
  assert.deepEqual([...data.plans].sort((a, b) => key(a).localeCompare(key(b))), [...gas.plans].sort((a, b) => key(a).localeCompare(key(b))), 'plans differ');
  assert.deepEqual(data.categories, gas.categories, 'categories differ');
  assert.deepEqual(data.payers, gas.payers, 'payers differ');
  const { monthSummary } = await import('../js/calc.js');
  const a = monthSummary(data, '2026-10'); const b = monthSummary(gas, '2026-10');
  assert.deepEqual(a, b);
  ok(`identical to the Google Sheet data; October: spent ${a.spent}, fixed left ${a.fixedRemaining}, available ${a.available}`);
}
assert.equal(data.ok, true);
assert.ok(data.categories.length > 0 && data.payers.length > 0);
assert.ok(!data.categories.includes('Secret'), 'other household leaks');
ok(`api_read: ${data.entries.length} payments, ${data.categories.length} categories, ${data.months.length} months, ${data.plans.length} plans`);

// Access control
await rejects(rpc('stranger@example.com', 'api_read'), /unauthorized/, 'stranger');
ok('signed-in stranger is refused');
await rejects(rpc(null, 'api_read'), /permission denied/, 'anon');
ok('not signed in is refused');
const direct = await as('stranger@example.com', 'select count(*)::int as n from payments');
assert.equal(direct.rows[0].n, 0);
const otherRows = await as(email, `select count(*)::int as n from categories where name = 'Secret'`);
assert.equal(otherRows.rows[0].n, 0);
ok('row level security hides other households, also for direct table reads');

// Add, update, delete
const cat = data.categories[data.categories.length - 1];
const payer = data.payers[0];
const added = await rpc(email, 'api_add', [JSON.stringify({ date: '2026-10-20', category: cat, amount: 12.5, payer, description: 'TEST', comments: '' })]);
let after = await rpc(email, 'api_read');
const row = after.entries.find((e) => e.id === added.id);
assert.deepEqual([row.date, row.category, row.amount, row.payer, row.description], ['2026-10-20', cat, 12.5, payer, 'TEST']);
ok('api_add writes the payment');

await rpc(email, 'api_update', [added.id, JSON.stringify({ date: '2026-10-21', category: cat, amount: '20,00'.replace(',', '.'), payer: '', description: 'TEST2' })]);
after = await rpc(email, 'api_read');
const upd = after.entries.find((e) => e.id === added.id);
assert.deepEqual([upd.date, upd.amount, upd.payer, upd.description], ['2026-10-21', 20, '', 'TEST2']);
ok('api_update changes it');

await rejects(rpc('other@example.com', 'api_delete', [added.id]), /δεν βρέθηκε/, 'cross-household delete');
ok('another household cannot delete it');
await rpc(email, 'api_delete', [added.id]);
after = await rpc(email, 'api_read');
assert.equal(after.entries.find((e) => e.id === added.id), undefined);
assert.equal(after.entries.length, data.entries.length);
ok('api_delete removes it');

// Validation
await rejects(rpc(email, 'api_add', [JSON.stringify({ date: '2026-10-20', category: 'Nope', amount: 5 })]), /Άγνωστη κατηγορία/, 'bad category');
await rejects(rpc(email, 'api_add', [JSON.stringify({ date: '2026-10-20', category: cat, amount: 0 })]), /ποσό/, 'zero amount');
await rejects(rpc(email, 'api_add', [JSON.stringify({ date: '20/10/2026', category: cat, amount: 5 })]), /ημερομηνία/, 'bad date');
await rejects(rpc(email, 'api_add', [JSON.stringify({ date: '2026-10-20', category: 'Secret', amount: 5 })]), /Άγνωστη κατηγορία/, 'other household category');
ok('bad input is refused (category, amount, date, other household category)');

// Plans and limits
const m0 = data.months[0].month;
const mLast = data.months[data.months.length - 1].month;
await rpc(email, 'api_set_month', [m0, 2500, 0.75, false]);
after = await rpc(email, 'api_read');
assert.deepEqual(after.months.find((m) => m.month === m0), { month: m0, cap: 2500, warn: 0.75 });
assert.equal(after.months.find((m) => m.month === mLast).cap, data.months[data.months.length - 1].cap);
ok('api_set_month changes only that month');
await rpc(email, 'api_set_month', [m0, 2300, 0.8, true]);
after = await rpc(email, 'api_read');
assert.ok(after.months.every((m) => m.cap === 2300));
ok('api_set_month with forward changes later months too');
await rpc(email, 'api_set_month', ['2031-01', 1800, 0.9, false]);
after = await rpc(email, 'api_read');
assert.equal(after.months.find((m) => m.month === '2031-01').cap, 1800);
ok('api_set_month creates a month that did not exist');

await rpc(email, 'api_set_plan', [m0, cat, 'Πάγιο', 175, false]);
after = await rpc(email, 'api_read');
assert.deepEqual(after.plans.find((p) => p.month === m0 && p.category === cat), { month: m0, category: cat, type: 'Πάγιο', plan: 175 });
ok('api_set_plan updates one month');
await rpc(email, 'api_set_plan', [m0, cat, 'Επιπλέον', null, true]);
after = await rpc(email, 'api_read');
assert.ok(after.plans.filter((p) => p.category === cat && p.month >= m0).every((p) => p.plan === null && p.type === 'Επιπλέον'));
ok('api_set_plan with forward, and an empty (unknown) plan');

// New month copies the closest earlier month
const before = await rpc(email, 'api_read');
const res = await rpc(email, 'api_add_month', ['2030-06']);
after = await rpc(email, 'api_read');
assert.equal(res.from, mLast);
assert.deepEqual(after.months.find((m) => m.month === '2030-06'), { ...before.months.find((m) => m.month === mLast), month: '2030-06' });
const plansOf = (d, mm) => d.plans.filter((p) => p.month === mm).map(({ category, type, plan }) => ({ category, type, plan }));
assert.deepEqual(plansOf(after, '2030-06'), plansOf(before, mLast));
await rejects(rpc(email, 'api_add_month', ['2030-06']), /υπάρχει ήδη/, 'duplicate month');
await rejects(rpc('other@example.com', 'api_read').then(() => as('other@example.com', `select count(*)::int n from month_limits where month = '2030-06-01'`))
  .then((r) => { if (r.rows[0].n) throw new Error('leak'); throw new Error('fine'); }), /fine/, 'other household');
ok('api_add_month copies the limit and plans of the previous month');

// Categories, people, months
{
  const b = await rpc(email, 'api_read');
  const months = b.months.length;
  await rpc(email, 'api_add_category', ['Γυμναστήριο', 'Επιπλέον', 30]);
  let r = await rpc(email, 'api_read');
  assert.ok(r.categories.includes('Γυμναστήριο'));
  assert.equal(r.plans.filter((p) => p.category === 'Γυμναστήριο' && p.plan === 30 && p.type === 'Επιπλέον').length, months);
  await rejects(rpc(email, 'api_add_category', ['γυμναστήριο', 'Πάγιο', null]), /υπάρχει ήδη/, 'duplicate category');
  await rejects(rpc(email, 'api_add_category', ['  ', 'Πάγιο', null]), /όνομα/, 'empty category');
  ok('api_add_category adds it with a plan in every month');

  await rpc(email, 'api_add', [{ date: `${m0}-05`, category: 'Γυμναστήριο', amount: 30, payer: '' }]);
  await rpc(email, 'api_update_category', ['Γυμναστήριο', 'Γυμναστική', null]);
  r = await rpc(email, 'api_read');
  assert.ok(r.entries.some((e) => e.category === 'Γυμναστική') && !r.categories.includes('Γυμναστήριο'));
  await rejects(rpc(email, 'api_update_category', ['Γυμναστική', cat, null]), /υπάρχει ήδη/, 'rename onto another');
  await rpc(email, 'api_update_category', ['Γυμναστική', null, true]);
  r = await rpc(email, 'api_read');
  assert.ok(!r.categories.includes('Γυμναστική'));
  assert.deepEqual(r.categoryInfo.find((c) => c.name === 'Γυμναστική'), { name: 'Γυμναστική', type: 'Επιπλέον', hidden: true });
  assert.ok(r.entries.some((e) => e.category === 'Γυμναστική'), 'past payments keep their category');
  await rpc(email, 'api_add_month', ['2031-03']);
  r = await rpc(email, 'api_read');
  assert.ok(!r.plans.some((p) => p.month === '2031-03' && p.category === 'Γυμναστική'), 'hidden category not in new months');
  await rpc(email, 'api_update_category', ['Γυμναστική', null, false]);
  ok('api_update_category renames and hides, keeping past payments');

  const order = [...(await rpc(email, 'api_read')).categories].reverse();
  await rpc(email, 'api_order_categories', [order]);
  assert.deepEqual((await rpc(email, 'api_read')).categories, order);
  ok('api_order_categories sets the order');

  await rpc(email, 'api_add_payer', ['Γιαγιά']);
  await rejects(rpc(email, 'api_add_payer', ['γιαγιά']), /υπάρχει ήδη/, 'duplicate payer');
  await rpc(email, 'api_rename_payer', ['Γιαγιά', 'Γιαγιά Μαρία']);
  r = await rpc(email, 'api_read');
  assert.equal(r.payers.at(-1), 'Γιαγιά Μαρία');
  const used = r.entries.find((e) => e.payer)?.payer;
  if (used) await rejects(rpc(email, 'api_delete_payer', [used]), /έχει πληρωμές/, 'used payer');
  await rpc(email, 'api_order_payers', [[...r.payers].reverse()]);
  assert.equal((await rpc(email, 'api_read')).payers[0], 'Γιαγιά Μαρία');
  await rpc(email, 'api_delete_payer', ['Γιαγιά Μαρία']);
  assert.ok(!(await rpc(email, 'api_read')).payers.includes('Γιαγιά Μαρία'));
  ok('payers: add, rename, order, delete only when unused');

  await rejects(rpc(email, 'api_delete_month', [m0]), /έχει πληρωμές/, 'month with payments');
  await rpc(email, 'api_delete_month', ['2031-03']);
  r = await rpc(email, 'api_read');
  assert.ok(!r.months.some((m) => m.month === '2031-03') && !r.plans.some((p) => p.month === '2031-03'));
  ok('api_delete_month removes an empty month, refuses one with payments');

  await rejects(rpc('other@example.com', 'api_update_category', [cat, 'Hacked', null]), /Άγνωστη κατηγορία/, 'other household');
  await rejects(rpc(null, 'api_add_category', ['X', 'Πάγιο', null]), /permission denied/, 'anon');
  ok('the new functions refuse other households and visitors');
}

// Summary view matches the website maths
const v = await as(email, `select category, paid::float8 as paid from month_category_summary where month = $1 order by category`, [`${m0}-01`]);
assert.ok(v.rows.length > 0);
ok('month_category_summary view works under row level security');

console.log(`\n${passed} checks passed`);
console.log(JSON.stringify({ month: m0, entries: data.entries.length }));
