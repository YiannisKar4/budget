-- Budget tracker schema for Supabase (PostgreSQL 15+).
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: it only creates what is missing and replaces the functions.
--
-- Access model: a household lists the email addresses allowed in (allowed_emails).
-- Row Level Security lets a signed-in user see and change only their household's rows.
-- The website talks to the database only through the api_* functions at the end.


-- ------------------------------------------------------------------ tables

create table if not exists households (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

create table if not exists allowed_emails (
  email        text primary key check (email = lower(email)),
  household_id uuid not null references households(id) on delete cascade
);

create table if not exists payers (
  id           smallint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  sort_order   smallint not null default 0,
  unique (household_id, name)
);

do $$ begin
  create type expense_type as enum ('fixed', 'extra');  -- Πάγιο / Επιπλέον
exception when duplicate_object then null; end $$;

create table if not exists categories (
  id           smallint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  default_type expense_type not null default 'extra',
  sort_order   smallint not null default 0,
  archived     boolean not null default false,
  unique (household_id, name)
);

create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  paid_on      date not null,
  category_id  smallint not null references categories(id),
  payer_id     smallint references payers(id),
  amount       numeric(10,2) not null check (amount <> 0),
  description  text not null default '',
  comments     text not null default '',
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists payments_month_idx on payments (household_id, paid_on);

create table if not exists month_limits (
  household_id uuid not null references households(id) on delete cascade,
  month        date not null check (extract(day from month) = 1),
  cap          numeric(10,2) not null check (cap >= 0),
  warn_ratio   numeric(4,3) not null default 0.8 check (warn_ratio > 0 and warn_ratio <= 1),
  primary key (household_id, month)
);

create table if not exists category_plans (
  household_id uuid not null references households(id) on delete cascade,
  month        date not null check (extract(day from month) = 1),
  category_id  smallint not null references categories(id) on delete cascade,
  type         expense_type not null,
  planned      numeric(10,2) check (planned >= 0),  -- null = unknown amount
  primary key (household_id, month, category_id)
);

-- ---------------------------------------------------------------- security

-- The signed-in user's household, from the email in their login token.
create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from allowed_emails
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

alter table households     enable row level security;
alter table allowed_emails enable row level security;
alter table payers         enable row level security;
alter table categories     enable row level security;
alter table payments       enable row level security;
alter table month_limits   enable row level security;
alter table category_plans enable row level security;

do $$
declare t text;
begin
  foreach t in array array['payers', 'categories', 'payments', 'month_limits', 'category_plans'] loop
    execute format('drop policy if exists household_only on %I', t);
    execute format(
      'create policy household_only on %I for all to authenticated
         using (household_id = my_household()) with check (household_id = my_household())', t);
  end loop;
end $$;

drop policy if exists own_household on households;
create policy own_household on households for select to authenticated using (id = my_household());
drop policy if exists own_email on allowed_emails;
create policy own_email on allowed_emails for select to authenticated using (household_id = my_household());

-- Nothing for visitors who are not signed in. Signed-in users get table rights,
-- and Row Level Security then limits them to their own household's rows.
-- (Written out here because "Automatically expose new tables" is turned off.)
revoke all on households, allowed_emails, payers, categories, payments, month_limits, category_plans from anon;
grant select on households, allowed_emails to authenticated;
grant select, insert, update, delete on payers, categories, payments, month_limits, category_plans to authenticated;
grant usage on all sequences in schema public to authenticated;

-- ----------------------------------------------------------------- helpers

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists payments_touch on payments;
create trigger payments_touch before update on payments
  for each row execute function touch_updated_at();

create or replace function _require_household() returns uuid
language plpgsql stable set search_path = public as $$
declare h uuid := my_household();
begin
  if h is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  return h;
end $$;

create or replace function _month(p text) returns date
language plpgsql immutable as $$
begin
  if p !~ '^\d{4}-\d{2}$' then raise exception 'Μη έγκυρος μήνας: %', p; end if;
  return to_date(p || '-01', 'YYYY-MM-DD');
end $$;

create or replace function _type(p text) returns expense_type
language sql immutable as $$
  select case p when 'Πάγιο' then 'fixed'::expense_type when 'Επιπλέον' then 'extra'::expense_type
                else p::expense_type end
$$;

-- ---------------------------------------------------------------- website API

-- Everything the website needs, in the same shape the Google Apps Script returned.
create or replace function api_read() returns json
language plpgsql stable set search_path = public as $$
declare h uuid := _require_household();
begin
  return json_build_object(
    'ok', true,
    'entries', coalesce((
      select json_agg(json_build_object(
        'id', p.id, 'date', to_char(p.paid_on, 'YYYY-MM-DD'), 'category', c.name,
        'description', p.description, 'amount', p.amount::float8,
        'payer', coalesce(y.name, ''), 'comments', p.comments) order by p.paid_on, p.created_at)
      from payments p join categories c on c.id = p.category_id left join payers y on y.id = p.payer_id
      where p.household_id = h), '[]'),
    'months', coalesce((
      select json_agg(json_build_object('month', to_char(m.month, 'YYYY-MM'), 'cap', m.cap::float8,
                                        'warn', m.warn_ratio::float8) order by m.month)
      from month_limits m where m.household_id = h), '[]'),
    'plans', coalesce((
      select json_agg(json_build_object(
        'month', to_char(cp.month, 'YYYY-MM'), 'category', c.name,
        'type', case cp.type when 'fixed' then 'Πάγιο' else 'Επιπλέον' end,
        'plan', cp.planned::float8) order by cp.month, c.sort_order)
      from category_plans cp join categories c on c.id = cp.category_id
      where cp.household_id = h), '[]'),
    'categories', coalesce((
      select json_agg(name order by sort_order, id) from categories
      where household_id = h and not archived), '[]'),
    'categoryInfo', coalesce((
      select json_agg(json_build_object('name', name, 'type', case default_type when 'fixed' then 'Πάγιο' else 'Επιπλέον' end,
                                        'hidden', archived) order by sort_order, id)
      from categories where household_id = h), '[]'),
    'payers', coalesce((
      select json_agg(name order by sort_order, id) from payers where household_id = h), '[]'),
    'updatedAt', now()
  );
end $$;

create or replace function _entry_values(h uuid, e jsonb,
  out o_date date, out o_category smallint, out o_payer smallint, out o_amount numeric)
language plpgsql stable set search_path = public as $$
begin
  if coalesce(e ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Μη έγκυρη ημερομηνία'; end if;
  o_date := (e ->> 'date')::date;
  o_amount := round((e ->> 'amount')::numeric, 2);
  if o_amount is null or o_amount = 0 then raise exception 'Μη έγκυρο ποσό'; end if;
  select id into o_category from categories where household_id = h and name = e ->> 'category';
  if o_category is null then raise exception 'Άγνωστη κατηγορία: %', e ->> 'category'; end if;
  if coalesce(e ->> 'payer', '') <> '' then
    select id into o_payer from payers where household_id = h and name = e ->> 'payer';
    if o_payer is null then raise exception 'Άγνωστο πρόσωπο: %', e ->> 'payer'; end if;
  end if;
end $$;

create or replace function api_add(entry jsonb) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); v record; new_id uuid;
begin
  select * into v from _entry_values(h, entry);
  insert into payments (household_id, paid_on, category_id, payer_id, amount, description, comments, created_by)
  values (h, v.o_date, v.o_category, v.o_payer, v.o_amount,
          coalesce(entry ->> 'description', ''), coalesce(entry ->> 'comments', ''), auth.uid())
  returning id into new_id;
  return json_build_object('ok', true, 'id', new_id);
end $$;

create or replace function api_update(id uuid, entry jsonb) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); v record; n int;
begin
  select * into v from _entry_values(h, entry);
  update payments p set paid_on = v.o_date, category_id = v.o_category, payer_id = v.o_payer,
         amount = v.o_amount, description = coalesce(entry ->> 'description', ''),
         comments = coalesce(entry ->> 'comments', '')
  where p.id = api_update.id and p.household_id = h;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Η πληρωμή δεν βρέθηκε. Κάνε ανανέωση και δοκίμασε ξανά.'; end if;
  return json_build_object('ok', true, 'id', id);
end $$;

create or replace function api_delete(id uuid) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); n int;
begin
  delete from payments p where p.id = api_delete.id and p.household_id = h;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Η πληρωμή δεν βρέθηκε. Ίσως έχει ήδη διαγραφεί.'; end if;
  return json_build_object('ok', true, 'id', id);
end $$;

-- Limit and warning for a month; with forward = true also every later month already set up.
create or replace function api_set_month(month text, cap numeric, warn numeric, forward boolean default false)
returns json language plpgsql set search_path = public as $$
declare h uuid := _require_household(); m date := _month(month); n int;
begin
  insert into month_limits as ml (household_id, month, cap, warn_ratio) values (h, m, cap, warn)
  on conflict on constraint month_limits_pkey do update set cap = excluded.cap, warn_ratio = excluded.warn_ratio;
  n := 1;
  if forward then
    update month_limits ml set cap = api_set_month.cap, warn_ratio = api_set_month.warn
    where ml.household_id = h and ml.month > m;
    get diagnostics n = row_count; n := n + 1;
  end if;
  return json_build_object('ok', true, 'changed', n);
end $$;

-- Starts a new month with the limit and plans of the closest earlier month
-- (or the earliest month, when it is before all of them).
create or replace function api_add_month(month text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); m date := _month(month); src date;
begin
  if exists (select 1 from month_limits ml where ml.household_id = h and ml.month = m) then
    raise exception 'Ο μήνας υπάρχει ήδη.';
  end if;
  select coalesce(max(ml.month) filter (where ml.month < m), min(ml.month)) into src
  from month_limits ml where ml.household_id = h;
  insert into month_limits (household_id, month, cap, warn_ratio)
  select h, m, coalesce(ml.cap, 0), coalesce(ml.warn_ratio, 0.8)
  from (select 1) one left join month_limits ml on ml.household_id = h and ml.month = src;
  insert into category_plans (household_id, month, category_id, type, planned)
  select h, m, c.id, coalesce(cp.type, c.default_type), cp.planned
  from categories c left join category_plans cp on cp.household_id = h and cp.month = src and cp.category_id = c.id
  where c.household_id = h and not c.archived;
  return json_build_object('ok', true, 'month', to_char(m, 'YYYY-MM'), 'from', to_char(src, 'YYYY-MM'));
end $$;

-- Plan for one category in a month (plan null = unknown); forward = also later months already set up.
create or replace function api_set_plan(month text, category text, type text, plan numeric, forward boolean default false)
returns json language plpgsql set search_path = public as $$
declare h uuid := _require_household(); m date := _month(month); cat smallint; t expense_type := _type(type); n int;
begin
  select id into cat from categories c where c.household_id = h and c.name = api_set_plan.category;
  if cat is null then raise exception 'Άγνωστη κατηγορία: %', category; end if;
  insert into category_plans as cp (household_id, month, category_id, type, planned) values (h, m, cat, t, plan)
  on conflict on constraint category_plans_pkey do update set type = excluded.type, planned = excluded.planned;
  n := 1;
  if forward then
    update category_plans cp set type = t, planned = api_set_plan.plan
    where cp.household_id = h and cp.category_id = cat and cp.month > m;
    get diagnostics n = row_count; n := n + 1;
  end if;
  return json_build_object('ok', true, 'changed', n);
end $$;

-- --------------------------------------------------- categories, people, months

-- A new category, with the same plan in every month already set up (plan null = unknown).
create or replace function api_add_category(category text, type text, plan numeric default null) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); n text := btrim(coalesce(category, '')); t expense_type := _type(type); cat smallint;
begin
  if n = '' then raise exception 'Γράψε όνομα κατηγορίας.'; end if;
  if plan < 0 then raise exception 'Μη έγκυρο ποσό.'; end if;
  if exists (select 1 from categories c where c.household_id = h and lower(c.name) = lower(n)) then
    raise exception 'Η κατηγορία «%» υπάρχει ήδη.', n;
  end if;
  insert into categories (household_id, name, default_type, sort_order)
  select h, n, t, coalesce(max(c.sort_order) + 1, 0) from categories c where c.household_id = h
  returning id into cat;
  insert into category_plans (household_id, month, category_id, type, planned)
  select h, ml.month, cat, t, plan from month_limits ml where ml.household_id = h;
  return json_build_object('ok', true);
end $$;

-- Rename a category and/or hide it (hidden categories leave the list for new payments and new months;
-- their past payments and plans stay).
create or replace function api_update_category(category text, new_name text default null, hidden boolean default null)
returns json language plpgsql set search_path = public as $$
declare h uuid := _require_household(); n text := btrim(coalesce(new_name, '')); cat smallint;
begin
  select c.id into cat from categories c where c.household_id = h and c.name = category;
  if cat is null then raise exception 'Άγνωστη κατηγορία: %', category; end if;
  if new_name is not null then
    if n = '' then raise exception 'Γράψε όνομα κατηγορίας.'; end if;
    if exists (select 1 from categories c where c.household_id = h and lower(c.name) = lower(n) and c.id <> cat) then
      raise exception 'Η κατηγορία «%» υπάρχει ήδη.', n;
    end if;
    update categories c set name = n where c.id = cat;
  end if;
  if hidden is not null then update categories c set archived = hidden where c.id = cat; end if;
  return json_build_object('ok', true);
end $$;

-- Display order: the names in the order they should appear.
create or replace function api_order_categories(names text[]) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household();
begin
  update categories c set sort_order = array_position(names, c.name) - 1
  where c.household_id = h and c.name = any(names);
  return json_build_object('ok', true);
end $$;

create or replace function api_add_payer(payer text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); n text := btrim(coalesce(payer, ''));
begin
  if n = '' then raise exception 'Γράψε όνομα.'; end if;
  if exists (select 1 from payers y where y.household_id = h and lower(y.name) = lower(n)) then
    raise exception 'Το «%» υπάρχει ήδη.', n;
  end if;
  insert into payers (household_id, name, sort_order)
  select h, n, coalesce(max(y.sort_order) + 1, 0) from payers y where y.household_id = h;
  return json_build_object('ok', true);
end $$;

create or replace function api_rename_payer(payer text, new_name text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); n text := btrim(coalesce(new_name, '')); pid smallint;
begin
  select y.id into pid from payers y where y.household_id = h and y.name = payer;
  if pid is null then raise exception 'Άγνωστο πρόσωπο: %', payer; end if;
  if n = '' then raise exception 'Γράψε όνομα.'; end if;
  if exists (select 1 from payers y where y.household_id = h and lower(y.name) = lower(n) and y.id <> pid) then
    raise exception 'Το «%» υπάρχει ήδη.', n;
  end if;
  update payers y set name = n where y.id = pid;
  return json_build_object('ok', true);
end $$;

-- Only someone with no payments can be removed; otherwise rename them.
create or replace function api_delete_payer(payer text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); pid smallint;
begin
  select y.id into pid from payers y where y.household_id = h and y.name = payer;
  if pid is null then raise exception 'Άγνωστο πρόσωπο: %', payer; end if;
  if exists (select 1 from payments p where p.payer_id = pid) then
    raise exception 'Το «%» έχει πληρωμές και δεν διαγράφεται. Μπορείς να το μετονομάσεις.', payer;
  end if;
  delete from payers y where y.id = pid;
  return json_build_object('ok', true);
end $$;

create or replace function api_order_payers(names text[]) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household();
begin
  update payers y set sort_order = array_position(names, y.name) - 1
  where y.household_id = h and y.name = any(names);
  return json_build_object('ok', true);
end $$;

-- Removes a month's limit and plans. Refused while the month has payments.
create or replace function api_delete_month(month text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _require_household(); m date := _month(month);
begin
  if exists (select 1 from payments p where p.household_id = h and p.paid_on >= m and p.paid_on < m + interval '1 month') then
    raise exception 'Ο μήνας έχει πληρωμές και δεν διαγράφεται.';
  end if;
  delete from category_plans cp where cp.household_id = h and cp.month = m;
  delete from month_limits ml where ml.household_id = h and ml.month = m;
  return json_build_object('ok', true);
end $$;

-- "Έλεγχος μήνα" as a view, for looking at the data straight from the SQL editor.
create or replace view month_category_summary with (security_invoker = true) as
select cp.household_id, cp.month, c.name as category, cp.type, cp.planned,
       coalesce(sum(p.amount), 0) as paid,
       greatest(cp.planned - coalesce(sum(p.amount), 0), 0) as remaining,
       greatest(coalesce(sum(p.amount), 0) - cp.planned, 0) as over
from category_plans cp
join categories c on c.id = cp.category_id
left join payments p on p.category_id = cp.category_id and p.household_id = cp.household_id
     and p.paid_on >= cp.month and p.paid_on < cp.month + interval '1 month'
group by cp.household_id, cp.month, c.name, c.sort_order, cp.type, cp.planned;

revoke all on function my_household(), _require_household(), _month(text), _type(text),
  _entry_values(uuid, jsonb), touch_updated_at() from anon, public;
grant execute on function my_household(), _require_household(), _month(text), _type(text),
  _entry_values(uuid, jsonb), touch_updated_at() to authenticated;
grant select on month_category_summary to authenticated;
revoke all on month_category_summary from anon;

revoke all on function api_read(), api_add(jsonb), api_update(uuid, jsonb), api_delete(uuid),
  api_set_month(text, numeric, numeric, boolean), api_add_month(text), api_set_plan(text, text, text, numeric, boolean) from anon, public;
grant execute on function api_read(), api_add(jsonb), api_update(uuid, jsonb), api_delete(uuid),
  api_set_month(text, numeric, numeric, boolean), api_add_month(text), api_set_plan(text, text, text, numeric, boolean) to authenticated;

revoke all on function api_add_category(text, text, numeric), api_update_category(text, text, boolean), api_order_categories(text[]), api_add_payer(text), api_rename_payer(text, text), api_delete_payer(text), api_order_payers(text[]), api_delete_month(text) from anon, public;
grant execute on function api_add_category(text, text, numeric), api_update_category(text, text, boolean), api_order_categories(text[]), api_add_payer(text), api_rename_payer(text, text), api_delete_payer(text), api_order_payers(text[]), api_delete_month(text) to authenticated;
