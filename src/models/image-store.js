/**
 * Stores each embedded image (a data:image/... URL) once in the `images` collection, keyed by
 * its SHA-256 hash. Saved documents and email payloads keep a short reference
 * ("stored-image:<hash>") instead of a copy of the logo, signature, stamp or QR image.
 * Reads put the images back, so pages, PDFs and emails receive exactly the data they did before.
 */

import { createHash } from 'node:crypto';

const PREFIX = 'stored-image:';
const REFERENCE = /^stored-image:([a-f0-9]{64})$/;
// Tiny images cost less inline than a lookup.
const MIN_STORED_LENGTH = 1024;

// Stored images never change (the key is their hash), so a cached copy is always correct.
// shortcut: bounded by entry count, not bytes (64 x 700 KB worst case); upgrade to a byte budget if memory matters.
const cache = new Map();
const CACHE_LIMIT = 64;
function remember(hash, dataUrl) {
  cache.delete(hash);
  cache.set(hash, dataUrl);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Returns a copy of `value` with large data:image strings replaced by references; `found` collects hash -> image. */
export function replaceImages(value, found) {
  if (typeof value === 'string') {
    if (value.length < MIN_STORED_LENGTH || !value.startsWith('data:image/')) return value;
    const hash = createHash('sha256').update(value).digest('hex');
    found.set(hash, value);
    return PREFIX + hash;
  }
  if (Array.isArray(value)) return value.map((item) => replaceImages(item, found));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceImages(item, found)]));
  return value;
}

function collectReferences(value, hashes) {
  if (typeof value === 'string') {
    const hash = REFERENCE.exec(value)?.[1];
    if (hash) hashes.add(hash);
  } else if (Array.isArray(value)) for (const item of value) collectReferences(item, hashes);
  else if (isPlainObject(value)) for (const item of Object.values(value)) collectReferences(item, hashes);
}

/** Returns a copy of `value` with references replaced by images from `images` (hash -> data URL). */
export function restoreImages(value, images) {
  if (typeof value === 'string') {
    // An image missing from the store keeps its reference: the page shows no image instead of failing.
    return images.get(REFERENCE.exec(value)?.[1]) ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => restoreImages(item, images));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreImages(item, images)]));
  return value;
}

/** pack(value) before saving; unpack(value) / unpackAll(values) after reading; saveImages(found) stores images. */
export function createImageStore(context) {
  const images = () => context.collection('images');

  async function saveImages(found) {
    for (const [hash, dataUrl] of found) {
      try {
        await images().updateOne(
          { _id: hash },
          { $setOnInsert: { dataUrl, createdAt: new Date() } },
          { ...context.options(), upsert: true },
        );
      } catch (error) {
        // Outside a transaction two writers can store the same new image at once; both copies are identical.
        if (error?.code !== 11000 || context.options().session) throw error;
      }
      remember(hash, dataUrl);
    }
  }

  async function unpackAll(values) {
    const hashes = new Set();
    collectReferences(values, hashes);
    if (!hashes.size) return values;
    const lookup = new Map();
    const unknown = [];
    for (const hash of hashes) {
      if (cache.has(hash)) lookup.set(hash, cache.get(hash));
      else unknown.push(hash);
    }
    if (unknown.length)
      for (const row of await images()
        .find({ _id: { $in: unknown } }, context.options())
        .toArray()) {
        lookup.set(row._id, row.dataUrl);
        remember(row._id, row.dataUrl);
      }
    return restoreImages(values, lookup);
  }

  return {
    async pack(value) {
      const found = new Map();
      const packed = replaceImages(value, found);
      await saveImages(found);
      return packed;
    },
    saveImages,
    unpackAll,
    unpack: async (value) => (value ? (await unpackAll([value]))[0] : value),
  };
}

/**
 * One-off conversion of documents and unsent emails saved before images were stored once.
 * Each record is rewritten only if nothing else changed it meanwhile; a marker skips the work
 * on later startups.
 */
export async function migrateStoredImages(context) {
  const marker = { _id: 'stored-images-v1' };
  const metadata = context.collection('workspace_metadata');
  if (await metadata.findOne(marker)) return { documents: 0, emails: 0 };
  const store = createImageStore(context);
  const counts = { documents: 0, emails: 0 };
  for await (const raw of context.collection('documents').find({})) {
    const found = new Map();
    const packed = replaceImages(raw, found);
    if (!found.size) continue;
    await store.saveImages(found);
    const result = await context
      .collection('documents')
      .replaceOne({ _id: raw._id, version: raw.version ?? { $exists: false } }, packed);
    counts.documents += result.modifiedCount;
  }
  const unsent = { status: { $in: ['held', 'queued', 'failed'] }, claim_token: null };
  for await (const raw of context.collection('email_outbox').find(unsent)) {
    const found = new Map();
    const payload = replaceImages(raw.payload, found);
    if (!found.size) continue;
    await store.saveImages(found);
    const result = await context
      .collection('email_outbox')
      .updateOne({ _id: raw._id, ...unsent, updated_at: raw.updated_at }, { $set: { payload } });
    counts.emails += result.modifiedCount;
  }
  await metadata.updateOne(
    marker,
    { $setOnInsert: { completedAt: new Date(), ...counts } },
    { upsert: true },
  );
  return counts;
}
