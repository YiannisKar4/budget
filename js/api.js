// Talks to the Google Apps Script web app attached to the sheet.
// Requests are sent as text/plain so the browser does not need a CORS preflight.

const SETTINGS_KEY = 'budget.settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings last for this visit only */
  }
}

export class ApiError extends Error {}

export async function call(settings, action, payload = {}) {
  if (!settings.url || !settings.key) throw new ApiError('not-configured');
  let res;
  try {
    res = await fetch(settings.url, {
      method: 'POST',
      body: JSON.stringify({ key: settings.key, action, ...payload }),
      redirect: 'follow',
    });
  } catch {
    throw new ApiError('Δεν υπάρχει σύνδεση με το Google Sheet. Έλεγξε το internet ή τη διεύθυνση του script.');
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('Το Google script δεν απάντησε σωστά. Έλεγξε ότι η διεύθυνση τελειώνει σε /exec.');
  }
  if (!body.ok) {
    if (body.error === 'unauthorized') throw new ApiError('Λάθος κλειδί. Έλεγξε τις Ρυθμίσεις.');
    throw new ApiError(body.error || 'Άγνωστο σφάλμα');
  }
  return body;
}
