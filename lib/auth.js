// Shared auth helper for all /api/* routes.
// Auth model: single bearer token in QIG_API_KEY env var.
// If QIG_API_KEY is unset, auth is OPEN (dev mode only — never deploy to prod without the key).

export const API_KEY = process.env.QIG_API_KEY || '';

export function auth(req) {
  if (!API_KEY) return true; // dev mode
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}
