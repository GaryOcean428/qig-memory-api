export const BROWSER_KEY_STORAGE = 'qig:last-api-key';
export const BROWSER_KEY_EVENT = 'qig-api-key-change';

export function rememberBrowserApiKey(token, key) {
  if (typeof window === 'undefined' || !token) return;
  const value = { token, id: key?.id || null, last4: token.slice(-4), savedAt: Date.now() };
  window.localStorage.setItem(BROWSER_KEY_STORAGE, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(BROWSER_KEY_EVENT, { detail: value }));
}

export function readBrowserApiKey() {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(BROWSER_KEY_STORAGE) || 'null');
    return value?.token ? value : null;
  } catch {
    return null;
  }
}

export function forgetBrowserApiKey() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(BROWSER_KEY_STORAGE);
  window.dispatchEvent(new CustomEvent(BROWSER_KEY_EVENT, { detail: null }));
}
