/** Unit tests: replacing embedded images with references and restoring them (src/models/image-store.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceImages, restoreImages } from '../src/models/image-store.js';

const logo = 'data:image/png;base64,' + 'A'.repeat(4000);

test('large images anywhere in a record become references and restore exactly', () => {
  const issuedAt = new Date('2026-10-10T00:00:00.000Z');
  const record = {
    organizationSnapshot: { name: 'Shop', logoUrl: logo, gstRegistrations: [{ id: 'r1' }] },
    branding: { logoMode: 'custom', logoUrl: logo, primarySignatureImageUrl: '' },
    items: [{ description: 'data:image/png is text here', rate: 10 }],
    issuedAt,
    empty: null,
  };
  const found = new Map();
  const packed = replaceImages(record, found);
  assert.equal(found.size, 1);
  assert.match(packed.organizationSnapshot.logoUrl, /^stored-image:[a-f0-9]{64}$/);
  assert.equal(packed.branding.logoUrl, packed.organizationSnapshot.logoUrl);
  assert.equal(packed.items[0].description, record.items[0].description);
  assert.equal(packed.issuedAt, issuedAt);
  assert.equal(record.organizationSnapshot.logoUrl, logo, 'the original record is not changed');
  assert.deepEqual(restoreImages(packed, found), record);
});

test('small images stay inline and unknown references are left as they are', () => {
  const tiny = 'data:image/png;base64,AAAA';
  assert.deepEqual(replaceImages({ tiny }, new Map()), { tiny });
  const reference = 'stored-image:' + 'a'.repeat(64);
  assert.equal(restoreImages(reference, new Map()), reference);
});
