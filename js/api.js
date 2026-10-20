// Talks to the database: Supabase when js/config.js has a project, otherwise the
// Google Apps Script web app attached to the sheet. Both answer with the same JSON.
// Apps Script requests are sent as text/plain so the browser does not need a CORS preflight.
import * as supa from './supa.js?v=7';
import { STORAGE_PREFIX } from './config.js?v=7';

const SETTINGS_KEY = `${STORAGE_PREFIX}.settings`;

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

export class ApiError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

export const usesSupabase = supa.enabled;

// Each site action and the database function that does it.
const RPC = {
  read: ['api_read', () => ({})],
  add: ['api_add', (p) => ({ entry: p.entry })],
  update: ['api_update', (p) => ({ id: p.id, entry: p.entry })],
  delete: ['api_delete', (p) => ({ id: p.id })],
  setMonth: ['api_set_month', (p) => ({ month: p.month, cap: p.cap, warn: p.warn, forward: !!p.forward })],
  addMonth: ['api_add_month', (p) => ({ month: p.month })],
  setPlan: ['api_set_plan', (p) => ({ month: p.month, category: p.category, type: p.type, plan: p.plan ?? null, forward: !!p.forward })],
};

async function callSupabase(action, payload) {
  const [fn, args] = RPC[action];
  try {
    return await supa.rpc(fn, args(payload));
  } catch (e) {
    if (e.message === 'login-required') throw new ApiError('Η σύνδεση έληξε. Συνδέσου ξανά με το email σου.', 'login-required');
    if (e.message === 'no-access') throw new ApiError(`Το email ${supa.userEmail()} δεν έχει πρόσβαση σε αυτά τα δεδομένα.`, 'no-access');
    throw new ApiError(e.message);
  }
}

export async function call(settings, action, payload = {}) {
  if (supa.enabled()) return callSupabase(action, payload);
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
