import { createHash } from 'node:crypto';

/**
 * This protocol is deliberately fixed across every application/worker process.
 * Changing its version or stripe count requires a coordinated stopped upgrade.
 */
export const TRANSACTION_LOCK_VERSION = 1;
export const TRANSACTION_STRIPE_COUNT = 32;
export const WORKSPACE_TRANSACTION_LOCK = 'workspace-writes';
export const TRANSACTION_STRIPE_IDS = Object.freeze(
  Array.from(
    { length: TRANSACTION_STRIPE_COUNT },
    (_, index) => `workspace-writes:v${TRANSACTION_LOCK_VERSION}:stripe:${String(index).padStart(2, '0')}`,
  ),
);
export const TRANSACTION_LOCK_IDS = Object.freeze([WORKSPACE_TRANSACTION_LOCK, ...TRANSACTION_STRIPE_IDS]);

export function organizationTransactionStripe(organizationId) {
  if (typeof organizationId !== 'string' || !organizationId || organizationId.length > 1000)
    throw new TypeError('An organization transaction requires its saved nonempty organization ID.');
  const digest = createHash('sha256').update(organizationId).digest();
  return TRANSACTION_STRIPE_IDS[digest.readUInt32BE(0) % TRANSACTION_STRIPE_COUNT];
}

export function transactionScope(options) {
  if (options === undefined) return { scope: 'workspace' };
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Transaction options must select an organization or the workspace scope.');
  const keys = Object.keys(options);
  if (keys.length === 1 && keys[0] === 'scope' && options.scope === 'workspace')
    return { scope: 'workspace' };
  if (keys.length === 1 && keys[0] === 'organizationId')
    return {
      scope: 'organization',
      organizationId: options.organizationId,
      stripe: organizationTransactionStripe(options.organizationId),
    };
  throw new TypeError('Select exactly one transaction organizationId or scope: workspace.');
}

export function assertNestedTransactionScope(parent, requestedOptions) {
  // Existing helper calls with no options deliberately inherit the caller's scope.
  if (requestedOptions === undefined) return;
  const requested = transactionScope(requestedOptions);
  if (parent.scope === 'workspace') return;
  if (requested.scope === 'organization' && requested.organizationId === parent.organizationId) return;
  throw new TypeError('A nested transaction cannot change organization or expand to workspace scope.');
}

/** Only the pre-created protocol rows may be ignored when checking an empty restore target. */
export function isTransactionCoordinationRow(row) {
  return Boolean(
    row &&
    TRANSACTION_LOCK_IDS.includes(row._id) &&
    Object.keys(row).sort().join(',') === '_id,revision' &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 0,
  );
}
