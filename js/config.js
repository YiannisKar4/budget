// Which database the site uses.
// With a Supabase project filled in below, the site signs in by email and uses Supabase.
// Left empty, it uses the Google Apps Script attached to the sheet (the original setup).
// Both values are public by design: the anon key only works together with a signed-in
// user, and Row Level Security in the database decides what that user can see.
export const SUPABASE_URL = 'https://ljsdwqpkqkvtyjrevwnk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_JWcVk0Y2g8iTLPOiRtuaIA_PtgWwpn7';

// Start of every key this site saves in the browser. A test copy of the site on the
// same address uses a different prefix, so it never touches the real site's settings.
export const STORAGE_PREFIX = 'budget';
