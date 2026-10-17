/**
 * Optional browser storage (sessionStorage). Used only for conveniences such as a toast shown after a
 * page change; if the browser blocks storage, saving and signing out still work.
 */

/** Optional notices must never turn a committed save or sign-out into a failed action. */
export function optionalSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Remembers a toast message to show on the next page. */
export function rememberNotice(message, storage = optionalSessionStorage()) {
  try {
    storage?.setItem('vc:toast', String(message || ''));
  } catch {
    // Saving the business record does not depend on an optional browser notice.
  }
}

/** Removes all of this app's stored values (keys starting with "vc:") on sign-out. */
export function clearWorkspaceStorage(storage = optionalSessionStorage()) {
  try {
    if (!storage) return;
    for (const key of Object.keys(storage)) if (key.startsWith('vc:')) storage.removeItem(key);
  } catch {
    // The server has already ended the session; always continue to the login page.
  }
}
