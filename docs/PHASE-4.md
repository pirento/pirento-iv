# Phase 4 — account security, concurrent writes and pending correctness fixes

Release **2.4.0** is the complete EJS, JavaScript, Express MVC and MongoDB project. It includes the original migration and every Phase 1–3 feature. Existing invoices, receipts, formats, payment adapters, reminder policies and recurring schedules continue using their saved records and calculation rules.

**Hindi:** Is phase mein My sessions, administrator Security activity, shared login protection, business-wise transaction coordination aur pending ledger/reminder fixes add hue hain. `.example.env` directly load hoti hai; credentials apne private setup mein bharne hain. Upgrade se pehle sab purane application aur worker processes band karna zaroori hai.

## 1. Account sessions and administrator activity

### My sessions

Open **Account → My sessions** in the sidebar. The page shows the signed-in user's active sessions across the workspace, with sign-in/expiry times in IST and a **Current** badge for this browser. Sessions are paginated at 50 per page and exclude expired records even before database cleanup removes them.

Choose **Sign out session** to end one session, or **Sign out other sessions** to keep this session while ending the others. Both actions show a confirmation first. Cancelling creates no revocation. Ending this session returns to the login page. If another session already ended, repeating its request succeeds without revoking a different session.

Session rows expose an independent record identifier, timestamps and the current-session flag. They never expose cookie tokens or stored token hashes. New rows use random UUID identifiers. Normal older MongoDB rows remain individually addressable through their independent ObjectId. Unusual imported session rows with unsupported custom identifiers can still be ended through the bulk control or the existing workspace Sign out button; their individual control is disabled.

The existing 12-hour session lifetime, login rotation, password-reset invalidation and access-change invalidation remain in place. Revocations recheck the active user and current session inside their transaction. A session ended after a request was already accepted cannot cancel work already underway.

### Team session controls

An administrator can open **Administration → Team access**, find the intended account and select **Sign out all sessions**. The confirmation names the account and warns when the administrator selected their own account. This action changes session access only; the person's role, active/pending/disabled status and business assignments stay as saved. An active person may sign in again using their credentials.

The server rechecks the acting administrator and current session inside the same transaction as revocation. Staff cannot use this endpoint. Existing protections against disabling/demoting the current administrator or removing the last active administrator still apply to the separate access editor.

### Security activity

Open **Administration → Security activity** to review recorded account activity across the workspace. Filter by inclusive Indian calendar dates, activity type, or an account involved as actor or affected user. Results show 50 events per page, newest first. Pagination retains the filters.

Events include existing owner provisioning, signup requests, successful sign-ins, password-reset outcomes and access changes, plus session revocations and bounded observations of unsuccessful sign-ins and request limits. Access changes show the before/after role, account status and business assignments. Account names and email addresses come from current account records; the activity log is not a historical name directory.

Repeated unsuccessful requests are deliberately sampled: at most one unsuccessful-login observation per client/window, and one observation at the first blocked request for a scope/window. Event totals therefore count observations, not all failed attempts. Observation failures do not change the generic authentication response. The activity API projects supported fields and sanitizes legacy details; arbitrary request bodies, headers, passwords, tokens and unknown action text are not rendered.

### API contracts

All mutation bodies use JSON and retain the existing origin and session guards. These account-wide endpoints do not accept an organization scope.

| Endpoint                                   | Behavior                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/sessions?page=1`            | Own active sessions as `{ sessions, total, asOf, pagination }`. Each session contains `id`, `createdAt`, `expiresAt`, `current`.                            |
| `POST /api/auth/sessions/:id/revoke`       | Body `{}`. End one own session. Returns `{ message, revokedSessions, signedOut }`; unavailable/already-ended targets produce a zero count.                  |
| `POST /api/auth/sessions/revoke-others`    | Body `{}`. End all other active sessions and preserve the current one. Same response shape.                                                                 |
| `POST /api/auth/users/:id/revoke-sessions` | Administrator, body `{}`. End the selected account's active sessions; self-revocation clears the cookie. Same response shape.                               |
| `GET /api/auth/audit`                      | Administrator. Optional `from`, `to`, `action`, `userId`, `page`. Returns `{ events, filters, pagination, actions }` with a supported action-label catalog. |

Session and audit pages are `/workspace/:organizationId/sessions` and `/workspace/:organizationId/security`. The business segment supplies the existing authorized workspace shell; account/session activity remains workspace-wide. Staff see only their own sessions and cannot open the administrator activity page/API. Bad dates, duplicate/non-scalar filters, unsupported actions and invalid pages return validation errors.

Implementation: [auth service](../src/services/auth/auth.js), [session/activity service](../src/services/auth/security.js), [EJS sessions](../views/security/sessions.ejs), [EJS activity](../views/security/activity.ejs), [browser controls](../public/js/security/sessions.js).

## 2. Shared authentication protection and proxy configuration

The account attempt limits now use atomic MongoDB counters shared by every process using the same application database. Restarting or moving a request to another application instance does not provide another allowance. Each scope retains its existing limits:

| Request scope   | Allowance per normalized client address |
| --------------- | --------------------------------------- |
| Login           | 20 requests per 15-minute window.       |
| Signup          | 10 requests per hour.                   |
| Forgot password | 8 requests per hour.                    |
| Reset password  | 15 requests per hour.                   |

The window starts with its first request. MongoDB's server clock controls expiry; application clock skew does not create additional windows. The shared counter increments atomically, caps its count and uses majority writes. The first-use upsert race is handled. IPv4 and equivalent IPv4-mapped IPv6 addresses use the same key. Counter identifiers are hashes of scope/address and are pseudonymous, not anonymous identities.

TTL removes expired counter rows, but authorization checks expiry directly because TTL removal is asynchronous. If the counter cannot be checked within its two-second budget, the request fails closed with HTTP 503 and `AUTH_RATE_LIMIT_UNAVAILABLE`, before password verification or account mutation. Rate-limited requests retain HTTP 429, the existing generic message and a `Retry-After` header. Counters do not take a financial coordination lock. Nonmatching passwords also avoid opening a financial/workspace transaction; successful authentication still rechecks current access and password state before creating its session.

`TRUST_PROXY` is the only new configuration input. It is blank by default. With no trusted proxy, the connected peer determines the client address, so a client-supplied `X-Forwarded-For` header cannot obtain another allowance. When hosting behind a known proxy, supply only its actual IP addresses or CIDR ranges, separated by commas. Booleans, hop counts, wildcard names and all-address ranges are rejected at startup. The trusted proxy must overwrite forwarded client/protocol/host headers before forwarding requests.

Do not copy an example proxy address into a deployment without checking its network path. The app cannot infer a hosting provider's actual trusted peers. A shared NAT can still make people share a client allowance; a distributed attack from many addresses is outside what one per-address counter can prevent. Rate limits are not a production traffic-capacity claim.

Implementation: [shared counter](../src/services/auth/account-rate-limit.js), [trusted-proxy validation](../src/config/trusted-proxy.js), [configuration template](../.example.env). The expiry and proxy choices follow the [MongoDB TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/) and [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

## 3. Business transaction coordination

The earlier global coordination write serialized all multi-record business transactions. Phase 4 introduces a fixed protocol with **32 organization lock stripes**. A deterministic hash maps an organization ID to one stripe. Two transactions assigned different stripes may overlap; the same business and businesses that collide on one stripe still serialize. A collision affects throughput, not record ownership or correctness.

The default workspace transaction remains genuinely exclusive: it acquires the existing `workspace-writes` row and all 32 stripe rows in a stable order before business reads. Global and unmigrated workflows therefore exclude organization-scoped writes as well. A separate global row without those stripe writes would not provide that exclusion.

```javascript
// Scoped business workflow.
await db.transaction(
  async () => {
    // Read current references and commit the complete business change here.
  },
  { organizationId },
);

// Existing/global workflow: excludes every organization stripe.
await db.transaction(async () => {
  // Cross-business or account administration change.
});
```

Nested calls without options inherit the parent's session/scope. A same-organization call also inherits; an exclusive parent may contain any scoped child. A scoped parent cannot change organization or expand to explicit `{ scope: 'workspace' }`, even if two organization IDs happen to share a stripe. These checks happen before the nested callback runs.

Routes starting with a document, receipt or message ID derive the organization from the saved resource or its parent invoice, then reload and verify that relationship inside the selected transaction. Request-supplied organization fields alone do not establish ownership. Legacy receipts missing their own organization field remain associated through the saved parent invoice; an explicitly conflicting organization is rejected. Assigned staff can also void those legacy receipts in their own business. The staff guard and transaction both verify the parent business, and malformed parent identifiers are rejected before a lookup.

Migrated writers include documents, customer creation/edit/deletion, catalog/products/formats, receipts and corrections, recurrence, reminders, payment-link reservations and verified gateway result commits, and financial email preparation/retry boundaries. Customer-delete versus invoice-create, format default/count, payment versus link reservation, cancellation versus first email transport, and policy versus reminder transport remain coordinated. Number allocation, document request identity, receipt/balance changes, outbox events and recurring occurrence records keep their existing atomic boundaries.

Organization creation/settings and prefix uniqueness, account administration, seed/import and recovery remain on the exclusive fallback. Provider HTTP requests stay outside retryable database transactions. Email claim/heartbeat/completion writes retain their existing atomic claim-token fencing and do not acquire business locks unnecessarily. Ledger and backup snapshot reads remain read-only and do not increment any coordination row.

All protocol rows are pre-created at startup. The stripe count/hash/version are code constants shared by every process, not environment tuning knobs. Missing coordination rows fail the write rather than allowing uncoordinated mutation. The application continues using snapshot reads, majority commits, primary preference and driver transaction retries, as described in the [MongoDB Node driver transaction documentation](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).

Implementation: [database](../src/config/database.js), [scope protocol](../src/config/transaction-scopes.js), [persisted ownership helper](../src/services/transaction-ownership.js). This removes unnecessary serialization between different stripes; it does not claim unrestricted concurrency, fixed latency or a measured production request rate.

## 4. Payment, ledger and automatic reminder fixes

### Legacy receipt rounding

MongoDB's previous receipt-summary rounding did not match the JavaScript financial helper at half-paise values. A legacy ₹0.125 receipt could be counted as 12 paise in a list and 13 paise in its statement, creating a false incomplete-history warning. Receipt summaries, active payment totals and the overdue installment filter now share one rounding expression matching JavaScript, including large safe integer values. Receipt aggregation rejects invalid/unsafe values and summation overflow.

For the regression fixture, a ₹1 invoice with saved paid amount ₹0.13 and an actual dated legacy ₹0.125 receipt now has **87 paise closing balance, zero artificial difference, complete history and no undated zero-balance row**. This does not permit sub-paise amounts in new payment requests; those remain rejected.

The same rounding mismatch also affected the overpayment guard: the historical ₹0.125 receipt could allow a further ₹0.88 payment on that ₹1 invoice. The guard now rejects ₹0.88 before any mutation and accepts the exact remaining ₹0.87. Payment replay, correction, correction replay and statement balances retain the same consistent totals. Invalid saved active receipts block new payment recording with HTTP 409 and `PAYMENT_DATA_INVALID`; voiding an incorrect numeric receipt remains possible so that the remaining active balance can be recalculated.

The overdue query previously rounded large safe odd paise integers up by one when it added 0.5 before taking the floor. A native regression with exactly one paise remaining on an overdue installment now agrees across the shared displayed status, filtered page and export. These cases cover legacy and numerical boundaries; new financial input still uses the existing whole-paise validation.

Statement loading also removes the redundant receipt-summary join before reading actual receipt history. Both reads remain inside one snapshot session. Draft/cancelled/unsupported invoice identities are retained where needed, while their list summaries avoid unnecessary receipt joins. Missing historical dates/status transitions still produce explicit history limitations; the fix does not invent old transactions.

### Due-date selection for automatic reminders

The automatic scheduler now selects candidate invoice due dates or installment due dates matching the current Indian day minus a configured policy offset. Separate compound indexes support the two date branches. The shared allocation rules, remaining balance, saved recipient, current policy/version, first-transport eligibility and durable event key remain authoritative after selection.

A native fixture with **1,211 open invoices** returned **10 candidate documents**, examining **10 documents and 12 index keys** through both date indexes without a collection scan. Seven valid reminders were queued; a repeated pass created zero and recognized seven existing events. Dashboard totals still included all **1,210 eligible targets**. These are controlled query measurements, not hosting/load measurements.

If the Indian day changes during a candidate pass, that old-date pass ends and the next pass selects the new day's candidates. Downtime still skips missed reminder dates. Dashboard totals, manual reminders, paid-installment allocation, policy review, PDF preparation and uncertain delivery retry behavior remain as before.

Implementation: [shared MongoDB money expressions](../src/models/money-expressions.js), [payment repository](../src/models/repositories.js), [ledger queries](../src/models/customer-ledger-queries.js), [candidate filter](../src/models/reminder-queries.js), [reminder service](../src/services/integrations/email/payment-reminders.js).

## 5. Upgrade, backup and recovery

**Stop every older application and worker process before starting 2.4.0.** A v2.3 process only writes the old global coordination row; it cannot coordinate safely with a new process using organization stripes. Old and new processes must not run together against the same database, including during a rolling deployment.

1. Prepare a verified backup and preserve private configuration. Stop traffic and every older process, and prevent its supervisor from restarting it.
2. Keep the existing database/outbox. Install this complete source and matching assets with `npm ci`. Use the blank `.example.env` as a key reference while retaining private values at the destination.
3. Configure `TRUST_PROXY` only if the actual proxy peers are known. Run the source/build and deployment checks, start all replacements on the same 2.4.0 code, and allow the new collections/indexes/coordination rows to initialize.
4. Require a healthy `/api/ready` response. Refresh browsers, review My sessions, a representative legacy statement/receipt correction and existing reminder/recurring settings before restoring normal traffic.

Startup does not backfill payments, enable reminder policies or activate recurring schedules. Existing sessions remain valid on a normal upgrade; a database restore still invalidates them.

Backups include the new counter and security data through the existing collection snapshot mechanism. Import/restore skips source coordination rows and uses the exact fresh destination protocol rows. Its empty-destination check permits only recognized coordination IDs with their expected fields; unknown rows or occupied business collections still block import. Counter rows are transient and retain their original expiry; the limiter checks the database clock before reusing them.

Recovery continues to hold email, clear session/reset and email-claim state, disable reminder policies and pause unfinished recurring schedules. `db:resume` releases only the global reconciliation hold. Business policies/schedules and uncertain external outcomes still need their existing explicit review. See [Deployment](DEPLOYMENT.md) and [Migration/recovery](MIGRATION.md).

## 6. Pending-work status and practical limits

| Item                                                                            | Phase 4 status / remaining action                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared account attempt limits and safe proxy configuration                      | Implemented, with cross-instance, expiry, spoofing and failure-path tests. Actual hosting proxy peers must be configured from the host's network setup.                                       |
| Own session controls and admin session revocation/activity                      | Implemented with authenticated EJS controls, authorization checks, pagination and escaped output.                                                                                             |
| Global write bottleneck                                                         | Reduced to fixed business stripes with an exclusive fallback. Same-stripe work and global workflows still serialize. Production sizing/load tests remain deployment-specific.                 |
| Legacy receipt/payment rounding, overdue boundary and redundant statement joins | Fixed and checked against real MongoDB, including overpayment rejection, receipt corrections and invalid/unsafe legacy values. Missing history is still reported explicitly.                  |
| Automatic reminder scan                                                         | Indexed due-date candidate selection implemented and measured on a controlled fixture. Dashboard targets and customer statement histories still require full relevant calculations in memory. |
| Existing financial/provider/worker/import flows                                 | Included in combined native and browser regression checks; see final counts in [Verification](VERIFICATION.md).                                                                               |
| Hosting, domain and actual MongoDB cutover                                      | Requires the intended host/database and its deployment configuration. This source release does not deploy or migrate an unprovided live database.                                             |
| Live payment, email and GST setup                                               | Requires the user's real accounts, sender verification and controlled live-environment acceptance. Automated checks use mocked provider transport.                                            |
| Very large reporting, offsite/native backups and production capacity            | Larger datasets need measured capacity planning. Current full-history reports and portable snapshots retain documented memory limits.                                                         |

The deliverable is a complete source ZIP with the maintained unit/native tests and setup guides. Final verification counts and the archive checks are recorded in [Verification](VERIFICATION.md).
