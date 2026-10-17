/**
 * Safe document creation and version checks.
 *
 * - A browser save carries a requestId; repeating the same request returns the same document
 *   instead of creating a duplicate (e.g. after a lost network response).
 * - Updates must carry the version the user edited; a newer saved version wins (409 conflict).
 */

import { createHash } from 'node:crypto';
import { HttpError } from '../../middleware/errors.js';

// Error codes sent to the browser so the editor can show the right conflict message.
export const DOCUMENT_VERSION_CONFLICT = 'DOCUMENT_VERSION_CONFLICT';
export const DOCUMENT_REQUEST_CONFLICT = 'DOCUMENT_REQUEST_CONFLICT';

function requestConflict(message, document) {
  const error = new HttpError(409, message, DOCUMENT_REQUEST_CONFLICT);
  if (document)
    error.document = { id: document.id, organizationId: document.organizationId, kind: document.kind };
  return error;
}

/** Object key order is irrelevant; line-item and installment order remain meaningful. */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
}

/** Throws 409 (DOCUMENT_VERSION_CONFLICT) unless the client's expected version matches the saved one. */
export function assertDocumentVersion(expectedVersion, document) {
  if (expectedVersion === undefined || expectedVersion !== document.version)
    throw new HttpError(
      409,
      'This document has changed or its version is missing. Open the latest saved version before applying your changes.',
      DOCUMENT_VERSION_CONFLICT,
    );
}

/**
 * One committed request creates one document, number and automatic email.
 * Request records survive draft deletion, so an old retry cannot recreate a deleted invoice.
 */
export function createDocumentWriter({ db, now, newDocument, getOrganization, getCustomer }) {
  return {
    async create(input, requestId) {
      const fingerprint = requestId
        ? createHash('sha256')
            .update(JSON.stringify(canonicalValue(input)))
            .digest('hex')
        : undefined;
      return db.transaction(
        async () => {
          if (requestId) {
            const receipt = await db.models.documentRequests.find(input.organizationId, requestId);
            if (receipt) {
              const saved = await db.models.documents.findById(receipt.documentId);
              const document = saved?.organizationId === input.organizationId ? saved : undefined;
              if (receipt.fingerprint !== fingerprint)
                throw requestConflict(
                  'This save request was already used for different document details. Review the saved document before starting another invoice.',
                  document,
                );
              if (!document)
                throw requestConflict(
                  'The document from this save request is no longer available. Review the document list before starting another invoice.',
                );
              return { document, created: false };
            }
          }
          const document = await newDocument(
            input,
            await getOrganization(input.organizationId),
            await getCustomer(input.customerId),
          );
          if (requestId)
            await db.models.documentRequests.insert({
              organizationId: input.organizationId,
              requestId,
              documentId: document.id,
              fingerprint,
              createdAt: now().toISOString(),
            });
          return { document, created: true };
        },
        { organizationId: input.organizationId },
      );
    },
  };
}
