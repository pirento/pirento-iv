import { HttpError } from '../middleware/errors.js';

/**
 * Resolve a persisted immutable owner before choosing a stripe, then reload under
 * that stripe. Request body ownership never chooses the lock for an existing row.
 */
export async function transactionForRecord(db, getRecord, action) {
  const initial = await getRecord();
  const organizationId = initial?.organizationId;
  if (typeof organizationId !== 'string' || !organizationId)
    throw new HttpError(409, 'The saved record has no available business. Review it before changing it.');
  return db.transaction(
    async () => {
      const current = await getRecord();
      if (!current || current.organizationId !== organizationId)
        throw new HttpError(409, 'The saved record changed businesses. Refresh it before applying changes.');
      return action(current);
    },
    { organizationId },
  );
}
