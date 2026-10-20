# Οικογενειακά έξοδα: budget tracker

A small website for the family budget Google Sheet (**Μηνιαία Έξοδα**).
The Google Sheet stays the database. The website reads it and writes to it through
a small Google Apps Script, so the sheet and its formulas keep working as before.

- **Μήνας**: the month overview (limit, actual spending, fixed bills still due, plan vs paid per category).
  It uses the same maths as the **Έλεγχος μήνα** tab.
- **Πληρωμές**: every payment, with search and filters. Tap one to edit or delete it.
- **Γραφήματα**: charts you can customise, add, reorder and delete. Your layout is saved on each device.
- **Πλάνα**: change the monthly limit, the warning level and each category's plan. These changes can apply to one month or to that month and every month after it.
- **+ Πληρωμή**: add a payment in a few taps. It goes straight into the **Καταγραφή** tab.

Everything is free: GitHub Pages hosts the site and Google runs the script on your own account.

## How it fits together

```
Phone / laptop  ──►  GitHub Pages (this repo: HTML + JS)
                         │  POST + secret key
                         ▼
                 Google Apps Script web app (apps-script/Code.gs)
                         │
                         ▼
                 Google Sheet "Μηνιαία Έξοδα"
```

None of your budget data is stored in this repo. The site only gets it from the
script, and the script answers only requests that carry your secret key.

## Setup (once, about 10 minutes)

### 1. Add the script to the sheet

1. Open the Google Sheet and go to **Extensions → Apps Script**.
2. Delete what is in `Code.gs` and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Optional: go to **Project Settings** (the gear icon), tick **Show "appsscript.json"**, and paste in
   [`apps-script/appsscript.json`](apps-script/appsscript.json).
   This sets the script's time zone to Athens.
4. Click **Save**. Choose `setup` in the function list at the top, then click **Run**.
   Google asks for permission the first time. Choose your account, click **Advanced → Go to … (unsafe)**,
   then **Allow**. This warning appears because the script is your own and Google hasn't reviewed it.
5. Open **Execution log**. It shows your **secret key**. Copy it.
   `setup` also adds an **ID** column (G) to the **Καταγραφή** tab. The site needs it to edit
   and delete the right row, so please don't remove it.

### 2. Publish the script as a web app

1. Click **Deploy → New deployment**. Next to "Select type", click the gear and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**.
3. Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

"Anyone" only means the URL can be called. Without the secret key the script returns nothing.

> When you change `Code.gs` later, use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**.
> The URL stays the same.

### 3. Turn on the website

1. In this GitHub repo, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the site is live at **https://yianniskar4.github.io/budget/**.

(GitHub Pages is free for public repositories. The code is public, but your data is not.)

### 4. Connect each phone or laptop

Open the site, paste the **Web app URL** and the **secret key**, and tap **Σύνδεση**.
They are saved on that device only. On a phone, use **Add to Home Screen** so it opens like an app.

## Good to know

- You can still type into the sheet directly. The site picks up those rows on the next refresh,
  and the script gives them an ID automatically.
- Deleting a payment clears its row instead of removing it, so the sheet's formula ranges
  (rows 5 to 2001) stay exactly as they are.
- New categories: add them to the list in **Έλεγχος μήνα** (A16:A32) and to the plan rows in
  **Ιστορικό και πλάνα**, as you do today. The site reads the category list from the sheet.
- One difference from the sheet: when a category's plan is exactly paid, the site shows
  **Πληρώθηκε** instead of **Κοντά στο όριο**. Everything else matches the sheet's formulas.
- A lost phone? Run `resetKey` in Apps Script to make a new key. The old one stops working,
  and you enter the new key on your other devices.

## Developing locally

`dev/mock-server.mjs` runs `Code.gs` against an in-memory copy of the sheet, so you can try the site without Google:

```
node dev/mock-server.mjs path/to/grid.json 8080
# open http://localhost:8080, script URL http://localhost:8080/exec, key "test"
```

`grid.json` holds the cell values of the three tabs (`{"<tab name>": [[...row...], ...]}`, dates as `{"$date": "yyyy-MM-dd"}`).
Keep real exports out of the repo.

### Releasing a change

GitHub Pages lets browsers cache files for about 10 minutes. After changing any `.js` or `.css` file,
raise the `?v=` number everywhere it appears (`index.html`, the imports at the top of `js/app.js` and `js/charts.js`),
so every phone loads the new files together instead of mixing old and new.
