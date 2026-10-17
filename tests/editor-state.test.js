/** Unit tests: invoice editor browser state - contact hand-off, local drafts and unsaved-request recovery. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginContactHandoff,
  canRestoreDraft,
  completeContactHandoff,
  consumeContactHandoff,
  discardLocalDraft,
  readStoredDraft,
  writeStoredDraft,
} from '../public/js/documents/editor-state.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
const token = 'a37bcb41-a13c-445c-8470-8c2da29cebb7';
const origin = {
  organizationId: 'example-business',
  draftId: 'the-originating-draft',
  returnTo: '/workspace/example-business/invoices/edit/invoice-a',
};

test('a contact creation is a one-time return to its exact originating draft', () => {
  const storage = memoryStorage();
  assert.equal(beginContactHandoff(storage, token, origin, 1000), true);
  assert.equal(completeContactHandoff(storage, token, { ...origin, contactId: 'buyer-b' }, 1001), true);
  assert.equal(consumeContactHandoff(storage, token, { ...origin, draftId: 'a-different-draft' }, 1002), '');
  assert.equal(
    consumeContactHandoff(
      storage,
      token,
      { ...origin, returnTo: '/workspace/example-business/invoices/new' },
      1002,
    ),
    '',
  );
  assert.equal(consumeContactHandoff(storage, token, origin, 1002), 'buyer-b');
  assert.equal(consumeContactHandoff(storage, token, origin, 1003), '');
});

test('standalone, cross-business, expired, and unfinished contact saves cannot select a buyer', () => {
  const storage = memoryStorage();
  assert.equal(completeContactHandoff(storage, null, { ...origin, contactId: 'standalone' }), false);
  assert.equal(beginContactHandoff(storage, token, origin, 1000), true);
  assert.equal(consumeContactHandoff(storage, token, origin, 1001), '');
  assert.equal(
    completeContactHandoff(
      storage,
      token,
      { ...origin, organizationId: 'another-business', contactId: 'buyer-b' },
      1001,
    ),
    false,
  );
  assert.equal(
    completeContactHandoff(storage, token, { ...origin, contactId: 'buyer-b' }, 1000 + 3 * 60 * 60 * 1000),
    false,
  );
  assert.equal(consumeContactHandoff(storage, token, origin, 1002), '');
});

test('blocked session storage fails closed instead of applying or losing a contact handoff', () => {
  const storage = {
    getItem() {
      throw new Error('Storage unavailable');
    },
    setItem() {
      throw new Error('Storage unavailable');
    },
    removeItem() {
      throw new Error('Storage unavailable');
    },
  };
  assert.equal(beginContactHandoff(storage, token, origin), false);
  assert.equal(completeContactHandoff(storage, token, { ...origin, contactId: 'buyer-b' }), false);
  assert.equal(consumeContactHandoff(storage, token, origin), '');
});

test('stale document drafts cannot restore over newer server revisions', () => {
  const saved = {
    updatedAt: '2026-10-10T10:00:00Z',
    version: 3,
    draft: { organizationId: 'example-business', kind: 'invoice', title: 'Unsaved notes' },
  };
  const document = { updatedAt: saved.updatedAt, version: 3 };
  assert.equal(canRestoreDraft(saved, document, 'example-business', 'invoice'), true);
  assert.equal(canRestoreDraft(saved, { ...document, version: 4 }, 'example-business', 'invoice'), false);
  assert.equal(
    canRestoreDraft(saved, { ...document, updatedAt: '2026-10-10T11:00:00Z' }, 'example-business', 'invoice'),
    false,
  );
  assert.equal(canRestoreDraft(saved, document, 'another-business', 'invoice'), false);
  assert.equal(canRestoreDraft(saved, document, 'example-business', 'quotation'), false);
});

test('an unresolved creation payload and its request ID survive browser storage round trips', () => {
  const storage = memoryStorage();
  const pending = {
    updatedAt: '',
    version: 0,
    requestId: token,
    draftId: 'new-draft',
    pendingCreate: true,
    draft: {
      organizationId: 'example-business',
      kind: 'invoice',
      title: 'One intended invoice',
      requestId: token,
      items: [{ description: 'Service', quantity: 1, rate: 100 }],
    },
  };
  assert.equal(writeStoredDraft(storage, 'new-document', pending), true);
  const restored = readStoredDraft(storage, 'new-document');
  assert.equal(canRestoreDraft(restored, undefined, 'example-business', 'invoice'), true);
  assert.deepEqual(restored, pending);
  assert.equal(restored.draft.requestId, restored.requestId);
});

test('explicit discard removes only the selected local draft and its recovery copy', () => {
  const storage = memoryStorage();
  writeStoredDraft(storage, 'selected-draft', { draftId: 'draft-a', draft: { title: 'Discard this' } });
  writeStoredDraft(storage, 'selected-draft:recovery', { draft: { title: 'Older local copy' } });
  writeStoredDraft(storage, 'other-draft', { draftId: 'draft-b', draft: { title: 'Keep this' } });
  assert.deepEqual(discardLocalDraft(storage, 'selected-draft', { draftId: 'draft-a' }), { discarded: true });
  assert.equal(storage.getItem('selected-draft'), null);
  assert.equal(storage.getItem('selected-draft:recovery'), null);
  assert.equal(readStoredDraft(storage, 'other-draft').draft.title, 'Keep this');
});

test('discard cannot erase unresolved creation IDs from memory, stored drafts or recovery copies', () => {
  for (const pendingLocation of ['memory', 'draft', 'recovery']) {
    const storage = memoryStorage();
    const draft = { draftId: 'draft-a', requestId: token, draft: { title: 'Keep this request' } };
    writeStoredDraft(storage, 'draft', { ...draft, pendingCreate: pendingLocation === 'draft' });
    if (pendingLocation === 'recovery')
      writeStoredDraft(storage, 'draft:recovery', { ...draft, pendingCreate: true });
    assert.deepEqual(
      discardLocalDraft(storage, 'draft', {
        draftId: 'draft-a',
        pendingCreate: pendingLocation === 'memory',
      }),
      { discarded: false, reason: 'pending' },
    );
    assert.equal(readStoredDraft(storage, 'draft').requestId, token);
    if (pendingLocation === 'recovery')
      assert.equal(readStoredDraft(storage, 'draft:recovery').requestId, token);
  }
});

test('discard refuses a different draft, unreadable storage or corrupted state without deleting it', () => {
  const storage = memoryStorage();
  writeStoredDraft(storage, 'draft', { draftId: 'draft-b', requestId: token });
  assert.deepEqual(discardLocalDraft(storage, 'draft', { draftId: 'draft-a' }), {
    discarded: false,
    reason: 'changed',
  });
  assert.equal(readStoredDraft(storage, 'draft').requestId, token);
  storage.setItem('draft', '{invalid json');
  assert.deepEqual(discardLocalDraft(storage, 'draft', { draftId: 'draft-a' }), {
    discarded: false,
    reason: 'storage',
  });
  assert.equal(storage.getItem('draft'), '{invalid json');
  assert.deepEqual(discardLocalDraft(undefined, 'draft', { draftId: 'draft-a' }), {
    discarded: false,
    reason: 'storage',
  });
});
