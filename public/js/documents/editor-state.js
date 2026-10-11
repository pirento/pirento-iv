/** Session storage contains browser drafts only; the server remains the source of saved documents. */
export function readStoredDraft(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

export function writeStoredDraft(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStoredDraft(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Explicit discard cannot remove an unresolved creation or a different editor's local state. */
export function discardLocalDraft(storage, key, { draftId, pendingCreate = false } = {}) {
  if (pendingCreate) return { discarded: false, reason: 'pending' };
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    const recovery = JSON.parse(storage.getItem(`${key}:recovery`) || 'null');
    if (saved?.pendingCreate || recovery?.pendingCreate) return { discarded: false, reason: 'pending' };
    if (saved?.draftId && saved.draftId !== draftId) return { discarded: false, reason: 'changed' };
    storage.removeItem(key);
    storage.removeItem(`${key}:recovery`);
    // Any old contact handoff remains bound to the discarded draft ID and cannot select a new buyer.
    return { discarded: true };
  } catch {
    return { discarded: false, reason: 'storage' };
  }
}

/** A local draft may only restore against the server revision from which editing began. */
export function canRestoreDraft(saved, document, organizationId, kind) {
  return Boolean(
    saved?.draft &&
    saved.draft.organizationId === organizationId &&
    saved.draft.kind === kind &&
    saved.updatedAt === (document?.updatedAt || '') &&
    (saved.version ?? 0) === (document?.version ?? 0),
  );
}

export const CONTACT_HANDOFF_PARAM = 'contactHandoff';
const contactKey = (token) => `vc:contact-handoff:${token}`;
const handoffLifetime = 2 * 60 * 60 * 1000;
const validToken = (token) => typeof token === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(token);

function readHandoff(storage, token, now) {
  if (!validToken(token)) return null;
  const entry = readStoredDraft(storage, contactKey(token));
  if (
    !entry ||
    !Number.isFinite(entry.createdAt) ||
    entry.createdAt > now ||
    now - entry.createdAt > handoffLifetime
  ) {
    removeStoredDraft(storage, contactKey(token));
    return null;
  }
  return entry;
}

/** Only an editor can start a handoff, bound to this exact document/draft and return path. */
export function beginContactHandoff(storage, token, { organizationId, draftId, returnTo }, now = Date.now()) {
  if (!validToken(token) || !organizationId || !draftId || !returnTo) return false;
  return writeStoredDraft(storage, contactKey(token), {
    organizationId,
    draftId,
    returnTo,
    createdAt: now,
    contactId: null,
  });
}

/** A standalone Contacts save has no handoff and must never change any document's buyer. */
export function completeContactHandoff(
  storage,
  token,
  { organizationId, returnTo, contactId },
  now = Date.now(),
) {
  const entry = readHandoff(storage, token, now);
  if (
    !entry ||
    entry.contactId ||
    entry.organizationId !== organizationId ||
    entry.returnTo !== returnTo ||
    !contactId
  )
    return false;
  return writeStoredDraft(storage, contactKey(token), { ...entry, contactId });
}

/** Inspect a valid return before fetching its record; network failures must not consume the return. */
export function peekContactHandoff(storage, token, { organizationId, draftId, returnTo }, now = Date.now()) {
  const entry = readHandoff(storage, token, now);
  if (
    !entry?.contactId ||
    entry.organizationId !== organizationId ||
    entry.draftId !== draftId ||
    entry.returnTo !== returnTo
  )
    return '';
  return entry.contactId;
}

/** Return the contact once, only in the originating draft. Refreshes and other drafts cannot apply it. */
export function consumeContactHandoff(storage, token, scope, now = Date.now()) {
  const contactId = peekContactHandoff(storage, token, scope, now);
  return contactId && removeStoredDraft(storage, contactKey(token)) ? contactId : '';
}
