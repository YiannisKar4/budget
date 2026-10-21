# Οικογενειακά έξοδα: budget tracker

A small website for the family budget. It started on the Google Sheet **Μηνιαία Έξοδα**;
since October 2026 the data lives in **Supabase** (PostgreSQL, free plan).

Live at **https://yianniskar4.github.io/budget/**

- **Μήνας**: the month overview (limit, actual spending, fixed bills still due, plan vs paid per category).
  It uses the same maths as the sheet's **Έλεγχος μήνα** tab.
- **Πληρωμές**: every payment, with search and filters. Tap one to edit or delete it.
- **Γραφήματα**: charts you can customise, add, reorder and delete. Your layout is saved on each device.
- **Πλάνα**: the monthly limit, the warning level and each category's plan, for one month or that month
  and every month after it. **Δημιουργία μήνα** starts a new month from the one before.
- **+ Πληρωμή**: add a payment in a few taps.
- **Ρυθμίσεις → Κατηγορίες και πρόσωπα**: add, rename, hide and reorder categories and the
  "who paid" names. **Ρυθμίσεις → Εξαγωγή**: payments as a CSV for Excel, or a full JSON backup.

Everything is free: GitHub Pages hosts the site and Supabase hosts the database and sign-in.

## How it fits together

```
Phone / laptop  ──►  GitHub Pages (this repo: HTML + JS, no build step)
                         │  sign-in token
                         ▼
                 Supabase (Frankfurt)
                   ├─ Auth: email sign-in link, tokens
                   └─ API (PostgREST): /rest/v1/rpc/<function>
                         │
                         ▼
                 Postgres: api_* functions ──► tables, guarded by Row Level Security
```

- The site never reads or writes tables directly. It calls `api_*` functions that live in the database:
  `api_read`, `api_add`, `api_update`, `api_delete` (payments), `api_set_month`, `api_add_month`,
  `api_delete_month`, `api_set_plan` (months and plans), `api_add_category`, `api_update_category`,
  `api_order_categories`, `api_add_payer`, `api_rename_payer`, `api_delete_payer`, `api_order_payers`.
  They are defined in [`supabase/schema.sql`](supabase/schema.sql); Supabase publishes each one
  as `/rest/v1/rpc/<name>` automatically.
- `api_read` returns the same JSON the old Google Apps Script returned, so the page code
  (`js/calc.js`, `js/charts.js`, most of `js/app.js`) did not change.
- [`js/supa.js`](js/supa.js) is a small client for Supabase's REST endpoints (sign-in link or code,
  token refresh, rpc calls). No extra library is needed.
- [`js/config.js`](js/config.js) holds the project URL and the publishable key. Both are public by design.

## Who can see the data

- People sign in with their own email: they get a link, tap it, and that device stays signed in.
- Only emails in the `allowed_emails` table get any data. Anyone else who signs in sees
  "δεν έχει πρόσβαση".
- Row Level Security in the database limits every read and write to the signed-in person's household.
  Nobody gets anything without signing in.
- The **secret / service_role key** and the **database password** never go in the site or this repo.

## Who can sign in (Supabase dashboard → SQL Editor)

Everything else has a screen in the site. Access stays in the dashboard on purpose.
Add someone (remove with `delete from allowed_emails where email = '…';`):

```sql
insert into allowed_emails (email, household_id)
values ('someone@gmail.com', '00000000-0000-4000-8000-000000000001');
```

Backup: the free plan has no downloadable backups. Use **Ρυθμίσεις → Εξαγωγή → Πλήρες αντίγραφο**
now and then (a JSON file with everything).

Good to know:

- A free Supabase project pauses after 7 days with no use at all. Restore it from the dashboard; nothing is lost.
- The built-in email sender allows only a few emails an hour. Each device signs in once, so this is enough.
  To also show a sign-in code in the email (handy for an iPhone home-screen app), set up custom SMTP
  (for example Gmail with an app password) and add `{{ .Token }}` to the Magic Link template.
- One difference from the sheet: when a category's plan is exactly paid, the site shows
  **Πληρώθηκε** instead of **Κοντά στο όριο**.

## Changing the database

`supabase/schema.sql` is the source of truth. After changing it, paste the whole file into the
SQL Editor and run it. It is safe to re-run: it creates what is missing and replaces the functions,
and it never deletes data.

## Setting up from scratch

1. Create a Supabase project (Free, Frankfurt). Turn **off** "Automatically expose new tables";
   the schema grants rights itself.
2. SQL Editor: run [`supabase/schema.sql`](supabase/schema.sql).
3. Import the data: `python3 supabase/import_from_xlsx.py export.xlsx you@gmail.com partner@gmail.com > data.sql`
   (needs `pip install openpyxl`), then run `data.sql` in the SQL Editor.
   It holds your budget data, so never commit it.
4. Authentication → URL Configuration: Site URL `https://yianniskar4.github.io/budget/`,
   Redirect URLs `https://yianniskar4.github.io/budget/**`.
5. Put the project URL and publishable key in `js/config.js`.
6. GitHub: **Settings → Pages**, deploy from branch **main**, folder **/ (root)**.

## Developing locally

```
npm install
npm run test:db                 # schema, security and api_* on a local PostgreSQL (PGlite)
node dev/supabase-mock.mjs      # site on http://localhost:8090 with a fake Supabase on :8091
```

Sign in as `a@example.com`. No email is sent: the code and link are at
`http://localhost:8091/__mail?email=a@example.com`. Pass a `data.sql` to the mock to try it with real data.

### Releasing a change

GitHub Pages lets browsers cache files for about 10 minutes. After changing any `.js` or `.css` file,
raise the `?v=` number everywhere it appears (`index.html` and the imports at the top of the files in `js/`),
so every phone loads the new files together instead of mixing old and new.
`dev/make-preview.sh` builds a test copy into `next/` (served at `/budget/next/`) that keeps its
browser data separate from the real site.

## The original Google Sheet version

The first version used the sheet as the database through a Google Apps Script
([`apps-script/Code.gs`](apps-script/Code.gs)), with a secret key on each device.
It still works: empty the two values in `js/config.js` and the site goes back to the sheet.

1. In the sheet: **Extensions → Apps Script**, paste `Code.gs`, run `setup` and copy the key from the log.
2. **Deploy → New deployment → Web app**, Execute as **Me**, access **Anyone**, copy the `/exec` URL.
3. On each device, enter the URL and key (or scan the QR code from Settings on a device that is already connected).

`dev/mock-server.mjs` runs `Code.gs` locally against a `grid.json` copy of the sheet:
`node dev/mock-server.mjs grid.json 8080`, script URL `http://localhost:8080/exec`, key `test`.
