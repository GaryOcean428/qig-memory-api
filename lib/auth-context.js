import { AsyncLocalStorage } from 'node:async_hooks';

const storage = globalThis.__qigAuthStorage || new AsyncLocalStorage();
globalThis.__qigAuthStorage = storage;

export function withPrincipal(principal, callback) {
  return storage.run(principal, callback);
}

export function currentPrincipal() {
  return storage.getStore() || null;
}
