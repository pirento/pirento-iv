# Changelog

Release notes, API contract changes and upgrade instructions for each version, newest first.

## Unreleased

- The TypeScript/React/SQLite source tree is replaced by this Express MVC, EJS, JavaScript and MongoDB application. Existing SQLite workspaces migrate with `npm run db:import-sqlite`.
- Synthetic preview restores the full original notice: a "TEST PREVIEW — NOT A VALID INVOICE" watermark on every printed page, the warning not to enter real data or credentials, and a guard that blocks links leaving the preview origin.
- Backup-location checks now cover the actual application folders (`public`, `shared`, `src`, `views`, `scripts`).
- Release-checkpoint files are consolidated: phase documents are merged into this changelog, `npm run audit:readiness` runs `scripts/readiness-audit.js`, and the redundant `audit:phase56`, `test:phase5` and `test:phase6` scripts are removed (`npm test` covers those tests).
- **Smaller database.** Business images (logo, signatures, stamp, payment QR) are stored once in a new `images` collection instead of being copied into every document and email record. Reads put them back, so pages, PDFs and emails are unchanged. Measured with four ordinary images: an invoice record went from 404 KB to 2.5 KB and a queued email from 408 KB to 7.6 KB.
- **Sent emails keep only their history.** Once an email is sent, its record keeps the business ID (and reminder details) instead of a full invoice copy, HTML and PDF. Queued, held and failed emails keep everything for exact retries.
- **Passwords.** Signed-in users can change their password on **My sessions** (other sessions are signed out). Administrators can set a new password for another person from **Team access**. API: `POST /api/auth/password`, `POST /api/auth/users/:id/password`.
- **Staff permission levels** on **Team access**: Full (default, unchanged), Edit without delete (no deleting, voiding receipts or cancelling documents) and View only. The server enforces them. `PATCH /api/auth/users/:id` accepts an optional `permission`, and user objects now include it.
- **GST returns (GSTR-1)** page under Receivables: B2B, B2CL, B2CS, HSN summary (B2B/B2C) and 0% lines for a month and seller GSTIN, each downloadable as CSV with the GST offline tool's headings.
- Unused empty files `shared/auth-types.js`, `shared/messaging-types.js` and `shared/online-payment-types.js` are removed, and every source file now starts with a short description (see [Code guide](CODE-GUIDE.md)).

**Upgrade (unreleased changes):** take a backup first and stop older application processes. On first start the new version converts existing documents and unsent emails to stored-image references and trims already-sent emails, once. Older versions cannot read the converted records, so going back to an older version means restoring the backup taken before the upgrade.

<a id="v2.5.0"></a>

## 2.5.0 — Decimal pricing, directory queries, startup and release verification

### Summary

This is the complete updated application, including the earlier phases. Phase 7 completes the reviewed reliability work and adds maintained browser verification to the source package.

**Hindi:** Naye invoice ki decimal rounding theek hai; purane saved invoice ka agreed amount apne aap nahi badlega. Browser notification storage unavailable ho tab bhi contact/product save aur logout complete hote hain. Contacts aur catalog ab 50 records per page dikhate hain; editor 20-record search pages use karta hai aur CSV mein saare matching records milte hain. `.example.env` ko directly fill karke setup ab bhi supported hai.

| Area                      | Included behavior                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact decimal pricing     | Decimal half-up calculation for new financial work, with a saved rounding-policy marker. Both `0.5 × 20.15` and `1.25 × 8.06` produce ₹10.08. Historical amounts are preserved until an editable draft is financially changed. |
| Reliable save/navigation  | Optional toast and logout storage errors cannot turn a successful server action into a reported failure. Critical draft/request recovery keeps its existing protection.                                                        |
| Production startup        | Normal production startup and the Hostinger entry use the same environment selection and read-only database preflight before initialization.                                                                                   |
| Release configuration     | Packaging and readiness checks reject duplicate template keys, malformed assignments and populated private settings, including values hidden behind a later blank duplicate.                                                   |
| Contacts and catalog      | Server search, filters, 50-row pages, complete filtered CSV, 20-row editor lookups, and selected-record hydration for archived records and draft returns. Tenant and record IDs use exact comparisons.                         |
| Reproducible verification | Included Playwright tests, strict native-test prerequisites, an isolated local replica-set runner and a GitHub Actions workflow.                                                                                               |

See [current verification results](VERIFICATION.md).

**Upgrade:** back up the existing database, preserve private configuration, stop older application/worker processes, replace the complete source and browser assets, then restart. Startup adds the two directory indexes. There is no historical-invoice repricing or destructive data migration. Production startup now deliberately refuses an unintended empty database; use `IV_ALLOW_NEW_DATABASE=true` only for an intentional first deployment and turn it off afterward.

### Details

Phase 7 implements the next reliability phase identified in the review of the supplied Phase 5–6 archive. This is a complete source release of the existing EJS, browser JavaScript, Express MVC/service-layer and native MongoDB application. Earlier account, document, payment, ledger, reminder, recurring, backup and recovery features remain included.

The work covers four confirmed defects, server-paged contact/catalog workflows, maintained browser/database verification and consistent release instructions. Current executed results are in [Verification](VERIFICATION.md).

### 1. Decimal financial calculations

The former calculation rounded an already imprecise binary multiplication. Values such as `0.5 × 20.15` and `1.25 × 8.06` could both become ₹10.07 even though their exact decimal product is 10.075.

New financial work uses exact decimal arithmetic internally and explicit half-up rounding at the existing business stages. Both examples now produce **₹10.08**. The same arithmetic covers standard and recurring line amounts, jewellery net weight and charges, invoice discount, taxable amounts and GST splits. For example, 18% of ₹13.25 rounds to ₹2.39. No new external calculation dependency or browser bundler is required; `shared/decimal.js` uses native `BigInt` internally and returns the application's existing numeric values at its boundary.

Newly calculated totals include:

```json
{
  "roundingPolicy": "decimal-half-up-v1"
}
```

The server remains authoritative. A caller cannot override saved totals by posting its own `totals` object. Existing whole-paise receipt validation, overpayment checks, financial locks and revision/request identity rules still apply.

#### Saved document compatibility

| Document action                                            | Financial behavior                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| View, print, PDF or email an older unmarked document       | Use the saved historical calculation policy; no silent repricing.             |
| Edit notes/title or issue an otherwise unchanged old draft | Preserve its saved totals and unmarked legacy policy.                         |
| Change allowed financial inputs on an editable draft       | Recalculate with the decimal policy and save the new marker.                  |
| Edit an issued document or invoice with receipts           | Retain existing financial locks; the rounding fix does not bypass them.       |
| Convert an existing quotation/proforma                     | Preserve the agreed commercial totals carried by conversion.                  |
| Generate a new recurring draft from an old source          | Calculate the new draft using the decimal policy; retain the source document. |

There is **no automatic historical backfill**. For an older document whose saved total is ₹10.07, its line, preview and PDF continue to show the matching historical value until an allowed financial draft edit occurs. Browser editor updates select the document's policy as well as the initial EJS render.

### 2. Successful actions and optional browser storage

Toast messages and convenience cleanup use guarded optional storage helpers. A browser that blocks session storage or runs out of storage space can still complete a successful contact/catalog save, ordinary management save, password reset redirect or logout. Failure to store a notification no longer changes the outcome already confirmed by the server.

This distinction matters for invoice recovery: the persisted draft identity, pending save request and contact-return token are required to prevent duplicate or misdirected work. Those critical paths retain their protective errors when reliable recovery cannot be established. Unknown creation results still use **Retry save**, and stale document revisions retain unsaved input for review.

### 3. One environment selection and production preflight

Every entry point uses this precedence:

1. Existing host/process environment values win, including values explicitly set to empty.
2. If a private `.env` exists, load it as the selected file.
3. Otherwise load `.example.env` directly.

The two files are not merged. A private `.env` replaces the file source; it does not inherit missing keys from `.example.env`. Existing direct-template deployments remain supported, and there is no requirement to create or rename a file. Normal startup, Hostinger startup, deployment checking and synthetic startup use the same loader.

With `NODE_ENV=production`, ordinary `server.js` startup now applies the same read-only preflight used by hosted startup, before collections/indexes or seed records are created. It checks supported Node version, trusted-proxy syntax, exact HTTPS public origin, database topology, intended existing workspace, recovery hold and active administrator or valid bootstrap credentials.

`PUBLIC_APP_URL` must be an origin such as `https://billing.example.com`. Paths, credentials, query strings, fragments and even a trailing slash are rejected. For an intentional first deployment only, set `IV_ALLOW_NEW_DATABASE=true` and valid initial administrator credentials; disable that opt-in after successful first startup. This prevents an accidental database-name change from silently creating another empty workspace.

The disposable synthetic entry remains separate and retains its dedicated database URI, isolation and destructive-operation guards. The production changes do not enable synthetic mode automatically.

### 4. Archive and readiness credential checks

The readiness audit and package builder inspect raw template assignments instead of relying on the final parsed value. They reject duplicate keys even when both values are blank. A populated secret followed by a later blank assignment is therefore rejected before packaging. Filled non-template values, malformed settings and unsupported multiline values are also rejected. Error messages do not echo credential values.

The package builder checks the staged copy again. It includes only approved source roots, rejects symlinks/private nested configuration, and excludes dependencies, `.git`, databases, backups, logs and local test reports. `.github/workflows/verify.yml`, `playwright.config.js` and maintained browser tests are now included. The normal package still starts the persistent application; use the explicit synthetic package command only for a disposable preview.

### 5. Contact and catalog directories

#### Workspace pages

Contact and catalog list pages query MongoDB for **50 rows per page**. Search and filters apply to the complete authorized matching set before paging. The matching-result count and page links reflect the requested filters; summary cards retain organization-wide counts. A changed filter returns to the first page. Add/edit/archive/restore workflows remain available.

Contact filters cover role and archived records. Catalog filters cover product/service, archived records, and the selected business product/shared offerings. Queries escape literal search strings before creating case-insensitive regex patterns. Request objects cannot become database query operators. Search strings are limited to 200 characters, and page/filter/identifier inputs are validated.

The new indexes have keys `{ organizationId: 1, name: 1, id: 1 }` and names `customers_directory_name_v1` / `catalog_directory_name_v1`. Both queries and indexes use simple binary collation. This preserves exact organization and record identity, including IDs differing only by letter case or leading zeroes. Name/ID ordering is stable; explicit text search remains case-insensitive.

Unfiltered sorted page plans are verified against the indexes. Substring search can still examine many records in a large organization; bounded response size is not a claim of constant-time search or production throughput. Very deep offset pages and large exports should be assessed against a real workload before further search/index design.

#### Editor lookups and complete exports

The editor loads **20 contacts and 20 catalog entries** initially, plus referenced selected records where necessary. Search and Next/Previous controls fetch another 20-record page. Catalog editor lookups for a selected business product include its items and shared offerings; list/export product filters select that product alone. Contact editor searches also cover PAN/address in addition to the directory list's contact fields. Debounced searches cancel or ignore stale responses. Draft recovery and add-contact return fetch referenced IDs in batches rather than depending on the first lookup page. Archived selected records remain available to saved documents.

| Endpoint                                                        | Response / purpose                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/customers/lookup?organizationId=…&q=…&page=1`         | `{ items, page, pageSize, hasMore }`, at most 20 search results.                          |
| `GET /api/catalog/lookup?organizationId=…&q=…&product=…&page=1` | The same bounded lookup response with catalog filters.                                    |
| Either lookup with `ids=ID1,ID2`                                | Fetch up to 50 exact, authorized referenced records, including selected archived records. |
| `GET /api/customers/export?organizationId=…`                    | Stream the complete matching contact CSV.                                                 |
| `GET /api/catalog/export?organizationId=…`                      | Stream the complete matching catalog CSV.                                                 |

Exports use the corresponding contact/catalog list page's search and filter semantics and include every matching row, independently of the displayed page. CSV cells quote embedded commas/quotes and neutralize formula prefixes. Export cursors are closed when the stream completes or is interrupted.

The original `GET /api/customers` and `GET /api/catalog` full-array contracts remain for existing clients. The list pages use paginated server queries; editor search and CSV export use the additive endpoints. This release does not claim every internal or compatibility endpoint is bounded.

### 6. Included verification workflow

The source includes Node unit/native tests plus a standard Playwright Chromium suite. Browser fixtures start the real authenticated Express/EJS server, use a dedicated MongoDB replica set, allocate uniquely named test databases, and remove their own data. Password-reset transport is captured locally; GST/email/payment transports are controlled. These checks do not send real mail or transfer money.

The browser suite covers login and mobile keyboard focus, saves/logout under blocked optional storage, password reset, decimal and legacy editor amounts, invoice preview/PDF download, a receipt balance, stale tabs, lost successful responses, directory paging/search/CSV and contact-return draft hydration. The native suite also exercises existing financial transactions, providers with controlled responses, account/security flows, leases, recurring/reminder automation and backup/import/recovery behavior.

#### Run against an existing dedicated test replica set

```bash
npm ci
npm run test:browser:install
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run verify:release
```

On Linux, Playwright may require system dependencies; its documented installation option is `npx playwright install --with-deps chromium`. If a suitable Chromium executable is already installed, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point to it. Neither browser binaries nor MongoDB binaries are embedded in the application ZIP.

#### Run with a temporary local replica set

```bash
# Requires an installed mongod and Chromium prepared above.
npm run verify:local

# Or select a specific mongod executable.
MONGOD_BINARY='/absolute/path/to/mongod' npm run verify:local
```

The launcher allocates a free loopback port, creates a temporary replica set, passes its URI to the requested command, then stops its processes and removes its own data. On POSIX it owns a separate process group for the verification command so interruption also cleans up command descendants. Windows uses direct-child process cleanup. Do not run integration tests with a production URI or production credentials; test users need permission to create/drop their uniquely named test databases.

`npm run test:integration` now fails if the URI is absent, if no tests execute or if any test is skipped. `npm run test:integration:optional` is the explicit local convenience command for a machine without a test database and clearly reports that no database tests ran. The release gate uses the strict command.

The included GitHub Actions workflow installs Node/dependencies/Chromium, starts the supplied MongoDB Compose replica set, runs `verify:release`, retains failure diagnostics briefly and removes its test container/data. The workflow is delivered as source; no remote GitHub Actions run or deployment was performed as part of this build.

### Upgrade and deployment

1. Make and verify a private backup of the intended existing database. Preserve private environment settings separately from the distributed blank template.
2. Stop older application and worker processes. Replace the full source and browser assets with this release, retaining the intended database and private settings.
3. Use Node 24.5 or newer, below 27. Run `npm ci` and `npm run build`. Production can omit dev dependencies after verification.
4. Set the target environment and run `npm run check:deployment`. For a new production database, use the explicit one-time bootstrap opt-in described above.
5. Start the application and require `/api/ready` to report readiness. Refresh existing tabs so the editor and server use the same code.
6. Review business settings and check the configured host/provider sandbox flows before enabling live payment or email accounts.

Startup adds the two directory indexes; it does not reprice saved invoices, remove receipts, reset the outbox or replace business data. Deploying this source is still a separate operation from building the archive. See [Deployment](DEPLOYMENT.md) for host, proxy, payment, email, GST and backup configuration.

### Scope and remaining work

This release completes the reviewed fixes and verification work. Proposed new modules such as credit notes/refunds, expanded permission roles, expenses/import tools, an owner dashboard and offsite backup storage remain separate feature work. Existing administrator/staff access, dashboard, imports and local backups retain their documented capabilities.

Executed checks establish the specific covered behavior with synthetic data and native database transactions. They do not certify the user's Hostinger configuration, live provider accounts, production capacity or an unprovided business database. The latest [verification record](VERIFICATION.md) identifies the runtime, exact counts and practical limits.

#### Primary implementation references

- [Playwright test fixtures](https://playwright.dev/docs/test-fixtures)
- [Playwright continuous integration](https://playwright.dev/docs/ci-intro)
- [MongoDB collation and case-insensitive index behavior](https://www.mongodb.com/docs/manual/core/index-case-insensitive/)

<a id="v2.4.0"></a>

## 2.4.0 — Account security, concurrent writes and pending correctness fixes

### Summary

This complete ZIP includes every earlier phase and adds account-session controls, administrator security history, shared authentication request limits, safe business transaction scopes and the remaining payment/ledger/reminder fixes.

**Hindi:** **My sessions** mein apne active logins dekh kar ek session ya baaki sab sessions sign out kar sakte hain. Admin **Security activity** mein account history dekh sakta hai aur **Team access** se kisi member ke sessions end kar sakta hai. Purani receipt rounding/correction compatibility fix hai; automatic reminders ab relevant due dates ko indexes se select karte hain.

| Area                          | Result                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared account protection     | MongoDB request counters preserve login/signup/reset limits across application instances and restarts; unavailable protection returns a controlled 503.                                                                                    |
| Account sessions              | Own sessions, timestamps, pagination, current-session indication, individual revocation and sign-out-others with confirmation.                                                                                                             |
| Administrator activity        | Filtered, paginated account history, safe before/after access details and selected-account session revocation.                                                                                                                             |
| Business writes               | Fixed organization stripes allow different stripes to overlap; the exclusive fallback still protects global settings, account administration and recovery.                                                                                 |
| Pending correctness/read work | Consistent legacy receipt/payment rounding, an exact overpayment guard, corrected overdue boundaries, parent-invoice ownership for legacy receipt voids, one receipt-history read per statement and indexed automatic-reminder candidates. |

**Upgrade requirement:** stop all older application and worker processes before starting 2.4.0. Old writers cannot coordinate with the new stripe protocol. Preserve the existing database and private configuration; startup creates the additional schema. `.example.env` adds optional **`TRUST_PROXY=`**, left blank until the actual hosting proxy peers are known. No new provider credentials are required.

See [Deployment](DEPLOYMENT.md) and [final verification results](VERIFICATION.md). The transaction/query improvements are verified with native MongoDB and controlled fixtures; production capacity and live provider/hosting setup still depend on the target environment.

### Details

Release **2.4.0** is the complete EJS, JavaScript, Express MVC and MongoDB project. It includes the original migration and every Phase 1–3 feature. Existing invoices, receipts, formats, payment adapters, reminder policies and recurring schedules continue using their saved records and calculation rules.

**Hindi:** Is phase mein My sessions, administrator Security activity, shared login protection, business-wise transaction coordination aur pending ledger/reminder fixes add hue hain. `.example.env` directly load hoti hai; credentials apne private setup mein bharne hain. Upgrade se pehle sab purane application aur worker processes band karna zaroori hai.

### 1. Account sessions and administrator activity

#### My sessions

Open **Account → My sessions** in the sidebar. The page shows the signed-in user's active sessions across the workspace, with sign-in/expiry times in IST and a **Current** badge for this browser. Sessions are paginated at 50 per page and exclude expired records even before database cleanup removes them.

Choose **Sign out session** to end one session, or **Sign out other sessions** to keep this session while ending the others. Both actions show a confirmation first. Cancelling creates no revocation. Ending this session returns to the login page. If another session already ended, repeating its request succeeds without revoking a different session.

Session rows expose an independent record identifier, timestamps and the current-session flag. They never expose cookie tokens or stored token hashes. New rows use random UUID identifiers. Normal older MongoDB rows remain individually addressable through their independent ObjectId. Unusual imported session rows with unsupported custom identifiers can still be ended through the bulk control or the existing workspace Sign out button; their individual control is disabled.

The existing 12-hour session lifetime, login rotation, password-reset invalidation and access-change invalidation remain in place. Revocations recheck the active user and current session inside their transaction. A session ended after a request was already accepted cannot cancel work already underway.

#### Team session controls

An administrator can open **Administration → Team access**, find the intended account and select **Sign out all sessions**. The confirmation names the account and warns when the administrator selected their own account. This action changes session access only; the person's role, active/pending/disabled status and business assignments stay as saved. An active person may sign in again using their credentials.

The server rechecks the acting administrator and current session inside the same transaction as revocation. Staff cannot use this endpoint. Existing protections against disabling/demoting the current administrator or removing the last active administrator still apply to the separate access editor.

#### Security activity

Open **Administration → Security activity** to review recorded account activity across the workspace. Filter by inclusive Indian calendar dates, activity type, or an account involved as actor or affected user. Results show 50 events per page, newest first. Pagination retains the filters.

Events include existing owner provisioning, signup requests, successful sign-ins, password-reset outcomes and access changes, plus session revocations and bounded observations of unsuccessful sign-ins and request limits. Access changes show the before/after role, account status and business assignments. Account names and email addresses come from current account records; the activity log is not a historical name directory.

Repeated unsuccessful requests are deliberately sampled: at most one unsuccessful-login observation per client/window, and one observation at the first blocked request for a scope/window. Event totals therefore count observations, not all failed attempts. Observation failures do not change the generic authentication response. The activity API projects supported fields and sanitizes legacy details; arbitrary request bodies, headers, passwords, tokens and unknown action text are not rendered.

#### API contracts

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

### 2. Shared authentication protection and proxy configuration

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

### 3. Business transaction coordination

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

### 4. Payment, ledger and automatic reminder fixes

#### Legacy receipt rounding

MongoDB's previous receipt-summary rounding did not match the JavaScript financial helper at half-paise values. A legacy ₹0.125 receipt could be counted as 12 paise in a list and 13 paise in its statement, creating a false incomplete-history warning. Receipt summaries, active payment totals and the overdue installment filter now share one rounding expression matching JavaScript, including large safe integer values. Receipt aggregation rejects invalid/unsafe values and summation overflow.

For the regression fixture, a ₹1 invoice with saved paid amount ₹0.13 and an actual dated legacy ₹0.125 receipt now has **87 paise closing balance, zero artificial difference, complete history and no undated zero-balance row**. This does not permit sub-paise amounts in new payment requests; those remain rejected.

The same rounding mismatch also affected the overpayment guard: the historical ₹0.125 receipt could allow a further ₹0.88 payment on that ₹1 invoice. The guard now rejects ₹0.88 before any mutation and accepts the exact remaining ₹0.87. Payment replay, correction, correction replay and statement balances retain the same consistent totals. Invalid saved active receipts block new payment recording with HTTP 409 and `PAYMENT_DATA_INVALID`; voiding an incorrect numeric receipt remains possible so that the remaining active balance can be recalculated.

The overdue query previously rounded large safe odd paise integers up by one when it added 0.5 before taking the floor. A native regression with exactly one paise remaining on an overdue installment now agrees across the shared displayed status, filtered page and export. These cases cover legacy and numerical boundaries; new financial input still uses the existing whole-paise validation.

Statement loading also removes the redundant receipt-summary join before reading actual receipt history. Both reads remain inside one snapshot session. Draft/cancelled/unsupported invoice identities are retained where needed, while their list summaries avoid unnecessary receipt joins. Missing historical dates/status transitions still produce explicit history limitations; the fix does not invent old transactions.

#### Due-date selection for automatic reminders

The automatic scheduler now selects candidate invoice due dates or installment due dates matching the current Indian day minus a configured policy offset. Separate compound indexes support the two date branches. The shared allocation rules, remaining balance, saved recipient, current policy/version, first-transport eligibility and durable event key remain authoritative after selection.

A native fixture with **1,211 open invoices** returned **10 candidate documents**, examining **10 documents and 12 index keys** through both date indexes without a collection scan. Seven valid reminders were queued; a repeated pass created zero and recognized seven existing events. Dashboard totals still included all **1,210 eligible targets**. These are controlled query measurements, not hosting/load measurements.

If the Indian day changes during a candidate pass, that old-date pass ends and the next pass selects the new day's candidates. Downtime still skips missed reminder dates. Dashboard totals, manual reminders, paid-installment allocation, policy review, PDF preparation and uncertain delivery retry behavior remain as before.

Implementation: [shared MongoDB money expressions](../src/models/money-expressions.js), [payment repository](../src/models/repositories.js), [ledger queries](../src/models/customer-ledger-queries.js), [candidate filter](../src/models/reminder-queries.js), [reminder service](../src/services/integrations/email/payment-reminders.js).

### 5. Upgrade, backup and recovery

**Stop every older application and worker process before starting 2.4.0.** A v2.3 process only writes the old global coordination row; it cannot coordinate safely with a new process using organization stripes. Old and new processes must not run together against the same database, including during a rolling deployment.

1. Prepare a verified backup and preserve private configuration. Stop traffic and every older process, and prevent its supervisor from restarting it.
2. Keep the existing database/outbox. Install this complete source and matching assets with `npm ci`. Use the blank `.example.env` as a key reference while retaining private values at the destination.
3. Configure `TRUST_PROXY` only if the actual proxy peers are known. Run the source/build and deployment checks, start all replacements on the same 2.4.0 code, and allow the new collections/indexes/coordination rows to initialize.
4. Require a healthy `/api/ready` response. Refresh browsers, review My sessions, a representative legacy statement/receipt correction and existing reminder/recurring settings before restoring normal traffic.

Startup does not backfill payments, enable reminder policies or activate recurring schedules. Existing sessions remain valid on a normal upgrade; a database restore still invalidates them.

Backups include the new counter and security data through the existing collection snapshot mechanism. Import/restore skips source coordination rows and uses the exact fresh destination protocol rows. Its empty-destination check permits only recognized coordination IDs with their expected fields; unknown rows or occupied business collections still block import. Counter rows are transient and retain their original expiry; the limiter checks the database clock before reusing them.

Recovery continues to hold email, clear session/reset and email-claim state, disable reminder policies and pause unfinished recurring schedules. `db:resume` releases only the global reconciliation hold. Business policies/schedules and uncertain external outcomes still need their existing explicit review. See [Deployment](DEPLOYMENT.md) and [Migration/recovery](MIGRATION.md).

### 6. Pending-work status and practical limits

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

<a id="v2.3.0"></a>

## 2.3.0 — Customer ledgers, reminders and recurring drafts

### Summary

This is the complete project, including all Phase 1 and Phase 2 changes. The new **Receivables** section adds customer ledgers, payment reminders and recurring invoice schedules using the same EJS, JavaScript, Express MVC and native MongoDB architecture.

**Hindi:** Customer ledger mein har contact ka received, outstanding aur overdue balance dekh sakte hain. Statement par date filter, complete CSV aur Print / Save PDF hai. Payment reminder pehle preview hota hai, phir queue hota hai; automatic reminders har business ke liye alag enable karne honge. Recurring schedule se har due date ka **draft invoice** banta hai, jise review karke issue/send karna hai.

| Area                 | Result                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer ledger      | Scoped customer balances, archived contacts, dated invoice/receipt/void entries, opening/closing balances where history permits, complete CSV and printable statements.           |
| Payment reminders    | Invoice/installment eligibility, manual preview and queue, daily duplicate protection, delivery history and administrator-managed reminder timing per business.                   |
| Recurring invoices   | Weekly/monthly/quarterly/yearly schedules, month-end anchors, frozen commercial inputs, current identity checks, reviewable drafts, pause/resume and occurrence/activity history. |
| Recovery and workers | A bounded shared automation runner, transactional duplicate prevention, graceful draining, reminder opt-out and recurring pause after database restore.                           |

Ledger statements use **current invoice status** and saved transaction dates. Where older records lack dated receipts, the UI explicitly marks incomplete history instead of calculating an unsupported historical balance. Automatic reminders are off by default. Recurring schedules start paused unless activation is explicitly selected; generated drafts are never automatically issued, charged or emailed.

Open and [verification results](VERIFICATION.md) for the completed checks. New collections/indexes are created on application startup; existing invoice, receipt and provider data is retained. Phase 3 introduced no new environment variables; Phase 4 adds optional `TRUST_PROXY`. Keep private `.example.env` values when replacing source, and upgrade the server and browser assets together.

### Details

Release: **2.3.0**. This release adds three connected receivables workflows to the complete EJS, JavaScript, Express MVC and native MongoDB application. It includes the [Phase 1 correctness fixes](#v2.1.0) and [Phase 2 performance, worker and operational changes](#v2.2.0).

The new **Receivables** navigation contains Customer ledger, Payment reminders and Recurring invoices. Each screen uses the selected business and the signed-in account's organization access. Existing invoice calculations, document kinds, receipts, financial locks, saved snapshots, payment gateways and document-email workflows remain available.

### Changes at a glance

| Feature            | What it provides                                                                                                                            | Default and access                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer ledger    | Searchable customer balances, dated invoice/receipt/void statements, complete matching CSV and a printable statement.                       | Read-only. Administrators and staff with access to the selected business can use it.                                                           |
| Payment reminders  | A preview and explicit manual queue action, optional automatic timing around unpaid invoice/installment dates, and delivery history.        | Automatic reminders start **off** for every business. Authorized staff can preview/queue; only administrators can change the automatic policy. |
| Recurring invoices | Explicit schedules that create separate invoice drafts, with pending dates, pause/resume, retry protection and occurrence/activity history. | New schedules default to **paused**. Administrators manage/generate; authorized staff can inspect schedules and history.                       |

No new environment variables or provider credentials are introduced. `.example.env` continues to load directly. Reminder delivery uses the existing configured sender for its business; recurring draft generation does not require a payment or email provider.

### 1. Customer ledger

#### Using balances, statements and exports

Open **Receivables → Customer ledger**. Search by saved customer name, email, phone, GSTIN or ID, then choose Active/Archived and All/Outstanding/Overdue filters. Search is literal and restricted to the selected business. The list defaults to 50 customers per page, and the four amount cards cover **all matching customer accounts**, including those on later pages.

Choose **Open statement** for a customer. From date and Through date are inclusive; blank bounds include all recorded dates on that side. Valid filter dates use `YYYY-MM-DD`, from 2000 through 2199. A date range changes the statement movements and opening/closing balances. The footer's current outstanding and overdue amounts continue to cover all currently issued invoices for that customer.

**Export all matches** and **Export statement** include the complete selected result, independently of pagination. **Print statement** opens all selected rows in a separate printable view; **Print / Save PDF** uses the browser's print dialog. Entered filters are carried into export and print, including changes not yet submitted with Apply. The export contains INR amounts with exact two-decimal formatting, escaped CSV cells and protection against formula-like text. Numeric credit balances remain numeric negative values.

Page examples:

```text
/workspace/ORGANIZATION_ID/ledger?q=ACME&balance=outstanding
/workspace/ORGANIZATION_ID/ledger?active=archived&download=csv
/workspace/ORGANIZATION_ID/ledger/preview/CUSTOMER_ID?from=2026-04-01&to=2026-06-30
/workspace/ORGANIZATION_ID/ledger/preview/CUSTOMER_ID?from=2026-04-01&to=2026-06-30&print=1
```

#### Financial scope and customer identity

The ledger is a read view over the existing invoice snapshots, payments and activity records. It does not create another financial journal or change source balances.

Only invoices currently saved as `sent`, `partially_paid` or `paid` contribute to receivables. Quotations, proformas and delivery challans do not contribute. Unissued drafts, cancelled invoices and unsupported invoice statuses are excluded; a customer statement lists its excluded invoices separately with links. If an excluded invoice has receipt history, its invoice and receipt movements are excluded together, with an explanation. The ledger does not infer a refund or backdate a cancellation.

Current invoiced, received and outstanding amounts preserve the existing shared financial calculations, including legacy `paid` status and saved paid/balance fallbacks. Overdue uses the current Indian business date and the same oldest-due-first installment allocation as the invoice/payment screens. A due date equal to today is due today, rather than overdue.

Accounts are associated only through the saved `document.customerId` inside the selected organization:

- Archived contacts remain available by default, and two contacts with the same name remain separate accounts.
- If a nonempty saved customer ID has no contact record, its account is still shown with a **Saved customer reference** notice and the latest matching invoice's customer snapshot.
- Invoices without a usable customer ID appear as a separate organization-level unlinked summary. Matching names or `customerSnapshot.id` values do not silently associate them with a contact. No synthetic customer ID or statement route is invented for this group.

The unlinked summary sits outside filtered customer totals. An entirely unfiltered customer CSV includes its separately labelled organization summary row; a filtered customer CSV contains only the matching customer accounts. The UI also provides a few source-invoice links for reviewing unlinked records.

#### A statement's date basis

Every statement permanently identifies its basis as **current invoice status**. The existing data does not record complete dated issuance and cancellation transitions. A statement therefore shows today's selected invoice set using its saved transaction dates; it is **not a historical as-of account** that can reconstruct the invoice statuses that existed on an earlier day. A later cancellation can change a statement rerun for the same earlier period.

The dated rows use these sources:

| Entry            | Date and amount                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice`        | Saved valid issue date; debit for the invoice total.                                                                                              |
| `receipt`        | Saved valid `paidOn`, or the original `providerPaidAt` converted to Asia/Kolkata when `paidOn` is missing/invalid; credit for the receipt amount. |
| `receipt_void`   | Saved valid void timestamp converted to Asia/Kolkata; debit reversing that receipt.                                                               |
| `legacy_balance` | An explicitly undated saved-balance difference. It explains the current snapshot without claiming a payment occurred on an invented date.         |

A receipt's creation time is not substituted for a missing payment date. Free-text activity descriptions are not parsed to invent financial amounts or dates. Activity counts can identify missing receipt/void records and flag incomplete history.

For complete dated records, the statement calculates the opening balance from rows before From date, then applies all movements in the selected window before pagination:

```text
opening balance + period debits − period credits = closing balance
period net receipts = period receipts − period receipt voids
```

This also preserves a valid negative credit balance when a recorded payment predates its invoice issue date. A later page's running balance includes earlier pages' movements.

Legacy paid invoices without receipt rows retain their current received and outstanding values. Missing/invalid source dates, undated differences, missing receipt history, inconsistent saved amounts or a void predating its receipt produce explicit notices. In these cases `history.complete` is false, formal opening/closing/running balances are `null`, and the UI displays **Not available**. Undated rows remain visible under every date filter. The API's `known…Paise` fields describe only the dated rows that can be calculated; they do not certify the missing history. Even when `history.complete` is true, the permanent current-status limitation still applies.

#### Ledger API contract

All endpoints require an authorized `organizationId` query parameter. The service also checks account/organization access itself, including exports and an individual customer lookup. A customer ID belonging only to another business cannot be used to obtain its statement.

| Method and endpoint                  | Query and result                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ledger`                    | `q`, `active` (all, active, archived), `balance` (all, outstanding, overdue), `page`, `pageSize`. Returns `customers`, all-matching `totals`, `unlinked`, `notices`, filters and pagination. |
| `GET /api/ledger/export`             | Same customer filters; downloads all matching customer balances as CSV.                                                                                                                      |
| `GET /api/ledger/:customerId`        | `from`, `to`, `page`, `pageSize`. Returns the customer, `rows`, current `summary`, selected `period`, `history`, `excludedDocuments` and pagination.                                         |
| `GET /api/ledger/:customerId/export` | Same date filters; downloads the complete statement, with opening/closing entries, current totals, notices and excluded invoices.                                                            |

`q` is limited to 200 characters. Pages are positive integer query strings; `pageSize` defaults to 50 and accepts 1–100. Pages beyond the result count are clamped. Empty results remain valid. Invalid dates, reversed date ranges, repeated/non-scalar filter values and invalid page sizes are rejected.

Ledger money fields are safe integer **paise**. For example, `12345` means INR 123.45. Customer/current-summary fields include `invoiceCount`, `invoicedPaise`, `receivedPaise`, `outstandingPaise`, `overduePaise`, `overdueInvoiceCount` and `unreceiptedCreditPaise`. The latter is the signed difference between saved paid amounts and active receipt records, not a new receipt.

Each row includes `type`, `date`, document/payment identifiers, `reference`, `description`, `debitPaise`, `creditPaise`, `balancePaise`, `knownBalancePaise` and a scoped document `href`. `period` includes opening/closing, invoiced/received/voided, debit/credit and known-balance fields. `history.basis` is always `current_invoice_status`. The service computes the full period before returning a page, so page size cannot change totals.

Implementation: [ledger service](../src/services/ledger/customer-ledger.js), [statement calculations](../src/services/ledger/ledger-statement.js), [read queries](../src/models/customer-ledger-queries.js) and [controller](../src/controllers/api/ledger.controller.js).

### 2. Payment reminders

#### Preview and queue a manual reminder

Open **Receivables → Payment reminders**. The dashboard shows unpaid invoice or installment dates with Overdue, Due today and Upcoming filters. A target requires a currently issued `sent` or `partially_paid` invoice, positive remaining balance and a valid due date. An installment plan uses the same allocation as the payment view; fully covered installments do not become reminder targets.

Use **Preview reminder** to review the invoice, saved recipient, subject, due date and remaining amount. **Queue reminder** creates an outbox entry after checking the target again. Missing recipient email or business sender configuration appears as an unavailable reason. Changing only the current contact record does not silently redirect an existing invoice's saved recipient.

The message includes the target balance, invoice balance, due date, the invoice's payment instructions and an invoice PDF. Reminders do not create or attach a gateway payment link and do not perform a gateway operation. Queueing reports acceptance into the local outbox; provider acceptance and failures appear in **Reminder history** and the invoice's email page.

Repeated manual requests for the same organization, invoice, installment, due date and Indian business day return the **same outbox message** with `duplicate: true`. They do not implicitly retry a failed/held delivery. A request on another Indian business day is a separate manual occurrence. A due date changed after preview causes a conflict instead of queueing the obsolete target.

#### Explicit automatic policy

An administrator can open **Automatic reminders**, choose timing, enable the checkbox and select **Save reminder settings**. Every business starts with automation off, even if the existing `EMAIL_AUTOMATION` setting is enabled. Conversely, an explicitly enabled reminder policy can work when that legacy flag is false. The two settings control different workflows.

| Policy or scheduler setting | Behavior                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial policy              | Disabled, revision 0, suggested offsets `[-3, 0, 3, 7]`.                                                                                   |
| Offset values               | 1–12 unique whole-day offsets, from 30 days before through 90 days after the due date; saved in sorted order.                              |
| Enabling requirements       | Existing configured sender for that business and the current policy `version`.                                                             |
| Effective date              | Enabling or meaningfully editing an enabled policy sets its effective date to today's Indian business date.                                |
| Automatic matching          | Queues only when `dueDate + offset` equals today's Indian business date and the current target is eligible.                                |
| Default queue limit         | Up to 100 newly queued automatic messages per service pass. The internal service accepts limits 1–500; this is not an environment setting. |

**Missed automatic reminder dates are not caught up after downtime.** An already queued message may still be delivered on a later day if it remains eligible, using refreshed wording and amounts before its first attempt. These are different cases: the scheduler does not create a new backlog of missed calendar events.

An automatic event is identified by organization, invoice, installment, due date and offset. Its identity does not include policy revision, so editing/re-enabling the policy cannot duplicate that rule/date event. Enqueue checks, policy revision, current invoice state and the unique outbox event key are protected by the existing shared write transaction.

A meaningful policy edit increments its revision and immediately holds unattempted automatic reminders, revoking their claims. Same-value saves are a no-op after checking the version. Old automatic rows remain held/deduplicated after re-enabling. Manual reminders and deliveries already attempted are unaffected by policy changes.

#### Delivery freshness and the retry boundary

Before the first provider transport, the worker checks the latest balance, installment allocation, cancellation, due date, automatic policy, recipient and sender. It refreshes an unattempted reminder's payload and PDF. If the invoice changes during PDF preparation, a final transaction detects the changed document, defers the message for 60 seconds and prepares it again. Paid/cancelled/ineligible targets or invalid policies are held without starting transport.

Once `first_attempt_at` is durably recorded, uncertain retries preserve the frozen provider request, PDF, sender and idempotency key. A later payment, cancellation or policy edit cannot recall transport that has already started. This boundary retains the Phase 2 renewable claims, stale-worker fencing, bounded shutdown and existing 23-hour provider retry safety window. Durable event uniqueness and provider idempotency do not promise exactly one external HTTP request under every network failure.

#### Reminder API contract

| Method and endpoint                       | Input and result                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reminders`                      | `organizationId`, optional `q`, `status` (all, overdue, due_today, upcoming), `page`. Returns `items`, counters, policy, public sender status and pagination.                    |
| `GET /api/reminders/history`              | `organizationId`, optional `page`. Returns paginated serialized reminder message metadata and reminder descriptors.                                                              |
| `GET /api/reminders/policy`               | `organizationId`; returns `{ policy }`.                                                                                                                                          |
| `PUT /api/reminders/policy`               | Administrator JSON: `organizationId`, numeric `version`, boolean `enabled`, integer `offsets` array. Returns `{ policy }`; stale revisions conflict.                             |
| `GET /api/documents/:id/reminder-preview` | Optional `installmentId`; omission selects the invoice-level target. Authorization follows the invoice's business. Returns the current preview, public sender status and policy. |
| `POST /api/documents/:id/reminders`       | JSON `installmentId` (string or null) and current `dueDate`. Returns HTTP 202 with `{ message, duplicate }`.                                                                     |

The dashboard and history each use 50 rows per page. Dashboard counters cover all eligible dated unpaid targets before text/status filters, including targets whose sender or recipient currently prevents sending. Reminder monetary fields retain the existing application's **INR number** contract; they are not the ledger API's `…Paise` fields. Message history excludes private payloads and PDF data.

Implementation: [reminder service](../src/services/integrations/email/payment-reminders.js), [eligibility and timing rules](../src/services/integrations/email/reminder-rules.js), [mailer](../src/services/integrations/email/mailer.js) and [controller](../src/controllers/api/reminders.controller.js).

### 3. Recurring invoice drafts

#### Create and review a schedule

An administrator opens **Receivables → Recurring invoices → Choose a source invoice**. Search finds the latest 25 matching saved, noncancelled invoices in the selected business. Choose **Use invoice**, review the source and copied items, then choose a schedule name, frequency, start date, due-day offset and optional end/occurrence limit.

Creation defaults to paused; activation is an explicit choice. An active schedule becomes eligible on its next date in India. **Generate due draft now** creates its one currently pending occurrence. Every generated document is a new **draft** with a new ID and the standard number for its scheduled issue date's financial year. Open it from the occurrence history, review the current snapshots and amounts, and issue it through the existing invoice workflow.

Recurring generation does not issue invoices, send an email or charge a customer. It never copies receipts, payment links, installments, finalization, conversion or delivery state. The source invoice is unchanged.

#### What is frozen and what is revalidated

Schedule creation freezes the source invoice's commercial inputs: items, quantities, rates, discount, place of supply, title, notes, terms and branding, together with the chosen customer, catalog, product, GST registration and format references. Later edits to the source invoice do not change the schedule template.

Each occurrence revalidates the current business, customer, catalog, product and format through the existing workspace service. It uses current identity/tax/format snapshots and recalculates totals from the saved commercial inputs. An archived/missing/incompatible reference or changed business billing profile stops generation for review. The implementation does not inject an obsolete saved source snapshot to bypass current validation.

Frequency, anchor date and source template are immutable. To change what is billed or its cadence, pause the old schedule and explicitly create a replacement from a reviewed invoice. Name, due-day offset, end date and maximum occurrence count can be edited while a schedule is paused or needs review. Settings cannot silently discard the next pending occurrence; completed schedules remain history.

| Schedule setting    | Supported behavior                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frequency           | Weekly, monthly, quarterly or yearly.                                                                                                               |
| Calendar            | Exact dates from 2000 through 2199, evaluated using the Indian business day.                                                                        |
| Month-end anchor    | Always derived from the original start date: January 31 → February 28/29 → March 31. A leap-day yearly anchor returns to February 29 in leap years. |
| Invoice due date    | Scheduled issue date plus 0–365 calendar days.                                                                                                      |
| End date            | Optional and inclusive.                                                                                                                             |
| Occurrence limit    | Optional, 1–1200, including the first occurrence.                                                                                                   |
| Lists and histories | 25 schedules, occurrences or activity events per page; occurrence and activity pages are separate.                                                  |
| Automatic pass      | At most 20 due schedules, creating at most one occurrence for each selected schedule.                                                               |
| Automatic cooldown  | A successful occurrence persists a next-eligible time at least 60 seconds later.                                                                    |

#### Backlog, failures and duplicate protection

After normal downtime, active schedules resume from their oldest pending date. Pending-through-today counts make the backlog visible. Each automatic pass advances it gradually; it does not generate the entire backlog in one operation. Pause stops future automatic generations while retaining the next date and history. **Review and resume** shows the pending date/backlog before restarting. Administrators can deliberately generate the next due draft themselves after reviewing it.

Schedule creation requires a UUID `requestId` and the saved source's `sourceVersion`. Repeating the same request/payload recovers the saved schedule. Reusing that request ID with changed input or creating from a stale source produces a conflict. The browser retains the exact unresolved request across reloads and offers **Retry saved request**; unavailable request storage blocks creation rather than discarding its identity.

Updates, pause/resume and generation use the saved numeric schedule `version`. A stale tab keeps its entered values and offers the latest saved version for comparison. Each occurrence has a durable unique schedule/date record, and document creation, numbering, occurrence history and schedule advancement commit together in the existing MongoDB transaction. A generation retry for an already committed date returns that occurrence even if the schedule has advanced. Deleting its draft does not delete the occurrence marker or allow that date to create a replacement invoice silently.

If current references or validation prevent generation, the transaction does not create a partial draft or advance the date. The failure and attempt are recorded, the schedule enters **Needs review** (`error`), and automatic retries stop. Repair the relevant records, review the unchanged next date and select **Review and resume**. A successful retry keeps the earlier failure in history. Reaching the date/count boundary marks the schedule completed.

#### Recurring API contract

Read requests require `organizationId` in the query. Mutation requests require it in JSON and administrator access. Staff can read only their permitted businesses.

| Method and endpoint                         | Input and result                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/recurring-invoices`               | `organizationId`, optional `page`; projected schedules, pending counts and pagination.                                                                                                                                                                    |
| `GET /api/recurring-invoices/sources`       | `organizationId`, optional literal `q`; up to 25 matching source invoice summaries.                                                                                                                                                                       |
| `GET /api/recurring-invoices/:id`           | `organizationId`, optional `historyPage`, `eventPage`; schedule/template, occurrence history and activity with separate pagination.                                                                                                                       |
| `POST /api/recurring-invoices`              | `organizationId`, `sourceDocumentId`, numeric `sourceVersion`, UUID `requestId`, `name`, `frequency`, `startDate`, `dueDays`, optional `endDate`, `maxOccurrences`, `active`. Returns `{ created, schedule }`, HTTP 201 for creation or 200 for a replay. |
| `PUT /api/recurring-invoices/:id`           | `organizationId`, `version`, `name`, `dueDays`, optional `endDate` and `maxOccurrences`; updates reviewed editable settings.                                                                                                                              |
| `POST /api/recurring-invoices/:id/status`   | `organizationId`, `version`, `action: "pause"` or `"resume"`; returns the saved schedule.                                                                                                                                                                 |
| `POST /api/recurring-invoices/:id/generate` | `organizationId`, `version`, `occurrenceDate`; creates/replays the selected due occurrence and returns schedule, occurrence and document summary.                                                                                                         |

An omitted end date is empty, an omitted maximum occurrence limit is null, and `active` defaults to false. Generation returns HTTP 201 when created, 200 for a committed replay and 422 with `RECURRING_GENERATION_FAILED` for a recorded generation failure. Stale revision and changed creation-request conflicts use `RECURRING_VERSION_CONFLICT` and `RECURRING_REQUEST_CONFLICT` respectively. Unexpected errors retain the Phase 2 safe error/request-ID behavior.

Implementation: [recurring service and snapshot policy](../src/services/recurring/recurring-invoices.js), [calendar calculations](../shared/recurrence-dates.js), [controller](../src/controllers/api/recurring-invoices.controller.js) and [browser controls](../public/js/recurring/recurring.js).

### 4. Runtime, data and index principles

The normal HTTP runtime invokes the shared automation runner before processing the email queue. The runner begins no more frequently than once per **60 seconds per process**, coalesces overlapping passes and runs recurring generation followed by reminder scheduling. Its 60 seconds is a start interval, not an execution deadline. The existing 15-second worker tick checks when another pass is eligible. Automation requires a running application; no external cron, broker or scheduler account is provisioned.

On shutdown, the runner prevents further work and immediately asks both services to stop. Recurring generation already in progress and an in-flight reminder pass are awaited alongside HTTP requests, backups and the existing email worker. Phase 2 readiness becomes draining, the email worker retains its normal 20-second grace, and the production process retains its overall 30-second shutdown deadline.

The data additions are deliberately separate from financial source records:

| Collection or existing record                                    | Purpose and constraint                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `documents`, `payments`, `document_events`, `customers` | Ledger source data. No additional ledger collection or balance mutation is introduced. Organization/customer/invoice/date indexes support scoped reads.                                                                 |
| `payment_reminder_policies`                                      | One policy per organization, using organization ID as `_id`; revision and effective date govern automatic eligibility.                                                                                                  |
| Existing `email_outbox`                                          | New `payment_reminder` message kind with a structured reminder descriptor. The existing unique `event_key` and renewable claim rules remain authoritative. Added indexes support organization history and policy holds. |
| `recurring_invoice_schedules`                                    | Frozen template plus mutable progression/settings. Unique `(organizationId, requestId)` protects schedule creation; due and organization/list indexes support worker and page reads.                                    |
| `recurring_invoice_occurrences`                                  | Unique `(scheduleId, scheduledDate)` records the outcome and generated draft reference; retained after document deletion.                                                                                               |
| `recurring_invoice_events`                                       | Separate activity records for creation, edits, pause/resume, generation, completion and failures, indexed by organization/schedule/time.                                                                                |
| Generated invoice metadata                                       | `recurringScheduleId` and `recurringScheduledDate`; a partial unique index provides an additional occurrence constraint without affecting unrelated invoices.                                                           |

Ledger reads use a dedicated read-only MongoDB snapshot session so customer invoices and receipts agree during concurrent payment changes. They do not acquire or increment the application's write-transaction coordination lock. Automatic enqueue and recurring mutations retain that existing shared transaction lock, unique constraints and revision checks across processes.

All feature data is covered by the existing backup collection/index snapshot mechanism. No backfill creates a schedule, enables reminders, rewrites historical customer associations or guesses missing ledger history. Startup adds the new empty collections and indexes when upgrading an older database.

Implementation: [database/index registry](../src/config/database.js), [automation runner](../src/services/operations/automation-runner.js), [HTTP lifecycle](../src/services/operations/http-runtime.js) and [recovery](../src/services/operations/recovery.js).

### 5. Upgrade and recovery

#### Upgrade an existing Phase 1/2 workspace

1. Keep a verified backup and the existing private configuration/data directories. Use the complete 2.3.0 project and matching browser assets; keep `.example.env` values private.
2. Stop all older application and worker processes during the coordinated upgrade. Older releases do not understand every new reminder/recurring recovery rule; Phase 1 workers also lack Phase 2's claim fencing. Do not mix these worker versions against the same outbox.
3. Install with `npm ci`, start against the existing transaction-capable MongoDB replica set or supported sharded deployment, and allow the additional collections/indexes to initialize. Plan index creation time for a large existing collection.
4. Check `/api/ready`, refresh browser tabs, sign in and review representative current customer totals and legacy notices. Existing `GET /api/documents` still returns its full array, and the existing Phase 1 request-ID/revision contracts remain in force.
5. Create/activate recurring schedules and enable reminder policies only after reviewing their inputs. A normal upgrade does not automatically opt any business into either feature.

The new endpoints and pages are additive. The MongoDB backup format, existing document calculation rules and `.example.env` loading remain compatible. See [Deployment](DEPLOYMENT.md) and [Migration, backup and recovery](MIGRATION.md) for the full installation/cutover procedure.

#### Restore a snapshot, then review automations

Use the existing verified restore process into a new empty database, keeping the application stopped during review. Restore invalidates sessions/reset tokens, holds queued/sending messages, clears email claims and establishes the global recovery hold.

Phase 3 recovery additionally **disables every reminder policy** and **pauses every unfinished recurring schedule**, incrementing their revisions. It retains occurrence records, generated document references, pending dates and history. Completed schedules remain completed. Older snapshots without these collections restore normally; startup creates the absent collections.

Reconcile invoices, numbers, receipts, external payment/email activity and any drafts generated after the snapshot was taken. The existing `db:resume -- --database=NAME --acknowledge-reconciled` command acknowledges that review and releases the global hold. It does not enable reminder policies, resume recurring schedules or send held emails.

After signing in, review each unfinished schedule's next date, backlog and occurrence history before explicitly resuming it. Resume preserves the pending date and can generate older due drafts in bounded passes. A snapshot cannot know about a later occurrence missing from that snapshot; review prevents treating the restored database as complete post-snapshot history.

Review each business's sender and timing before re-enabling automatic reminders. The new policy revision/effective date prevents the scheduler from catching up missed reminder dates. Previously held unattempted automatic rows remain held; attempted requests must be reviewed against provider history before retry. A database restore cannot retract an email or payment already accepted by an external provider.

### 6. Verification and practical limits

This section records the Phase 3 release. [Phase 4](#v2.4.0) subsequently fixes legacy receipt rounding, removes a redundant statement join, adds indexed automatic-reminder date selection and replaces the single global writer lock with fixed business stripes plus an exclusive fallback. Full-history reporting/dashboard memory limits and unavailable historical data remain as described below.

See [Verification](VERIFICATION.md) for the final combined counts, commands and browser acceptance evidence. Dedicated tests exercise integer-paise and date boundaries; partial/full receipts, voids, cancellation and legacy-paid records; organization access; archived/same-name/missing contacts; full CSV/print pagination; snapshot consistency; reminder policy/queue/provider races; month-end recurrence; two-worker/repeated occurrence protection; lost responses; failures and restore review. Browser acceptance covers the authenticated EJS workflows, confirmation controls, stale forms, pagination, exports and 390-pixel layouts.

These checks use disposable native MongoDB replica sets and controlled provider responses. They do not constitute a live payment/email delivery test, production data migration, hosting deployment or large-scale load benchmark.

The main remaining limits are explicit:

- A customer statement cannot reconstruct missing invoice status transitions or missing historical settlement dates. It reports incomplete history rather than inventing balances.
- Ledger lists scan relevant projected records and retain customer summaries; individual statements calculate the customer's complete projected history before pagination. Full exports/print are intentionally complete and can consume more memory for very large accounts.
- Reminder dashboards scan projected invoices and retain matching lightweight targets for sorting/pagination. Queue limits bound newly created messages per pass, not the total number of records scanned.
- Recurring catch-up is bounded by schedule count/cooldown and current validation. It generates drafts for review and requires the application to remain running. It does not schedule issuance, customer delivery or collection.
- The existing shared write-transaction lock remains a scaling constraint. Provider idempotency, worker leases and event uniqueness protect retry identity, but do not eliminate all external-delivery uncertainty.

Page-specific loading, the full-array legacy documents API, backup inventory's `verified: false` / `verification: "on_download"` contract, full backup verification on download/restore, request-ID diagnostics and operational readiness continue from Phase 2.

<a id="v2.2.0"></a>

## 2.2.0 — Performance, worker reliability and usability

### Summary

This full release includes the Phase 1 correctness fixes and implements the next six reviewed areas: page-specific data loading, fast backup inventory, renewable email worker leases, readiness and structured diagnostics, an accessible mobile menu, and explicit local draft controls.

**Hindi:** Invoice lists ab 50 records per page dikhati hain. Search aur filters poore matching data par chalte hain; CSV mein sabhi matching records aate hain. Mobile menu keyboard aur touch dono se close hota hai. **Start fresh** se naya local draft shuru kar sakte hain; pehle bheji hui save request ka result unknown ho to **Retry save** se use resolve karna zaroori hai.

| Area              | Result                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace loading | Each normal page loads its own dependencies. Lists use projected records; previews and editors fetch the selected full document. Overview totals still cover all records. |
| Backup navigation | Normal pages do not read backup inventory. The Backups page reads small metadata; a download still verifies the complete snapshot and checksum.                           |
| Email workers     | Each claim has an expiring token and heartbeat. A stale worker cannot update a newer claim. Shutdown stops new claims and drains the active delivery.                     |
| Operations        | `/api/ready` reports database/recovery readiness, safe JSON logs carry server-generated request IDs, and accepted work gets a bounded shutdown grace period.              |
| Mobile menu       | Escape, outside click, close button, focus management and background scroll protection are implemented.                                                                   |
| Local drafts      | Confirmed Start fresh creates a new draft. Discard unsaved changes reloads the saved document. Unknown creation results remain protected.                                 |

See [verification results](VERIFICATION.md). Upgrade the server and browser assets together, stop all older email workers before starting this version, and refresh existing tabs. New query/lease indexes are created at startup; `.example.env` and the existing business calculation rules are retained.

### Details

Release: **2.2.0**. This is the complete EJS, JavaScript, Express MVC and native MongoDB application, including the [Phase 1 correctness fixes](#v2.1.0). It implements the next six areas from the project review. The existing document kinds, pricing, financial locks, receipt rules, saved snapshots and provider integrations remain available.

### Changes at a glance

| Area              | Implemented behavior                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page loading      | Each normal workspace route loads its own dependencies. Document lists contain 50 projected records per page; individual document pages fetch the selected full document.                      |
| Backup navigation | Normal workspace pages do not inspect backups. The inventory reads metadata without re-reading complete snapshot contents. Full verification remains on download, manifest access and restore. |
| Email worker      | Unique claim tokens, lease renewal, guarded writes, stale-claim recovery and bounded draining protect concurrent workers and interrupted deliveries.                                           |
| Operations        | Database/recovery readiness, safe structured logs, request IDs and graceful process shutdown are integrated into the real server entry point.                                                  |
| Mobile navigation | A dismissible drawer manages focus, keyboard navigation, background interaction and scrolling.                                                                                                 |
| Draft controls    | Start fresh and Discard unsaved changes are explicit, confirmed actions. Unresolved creation requests remain protected until Retry save resolves them.                                         |

### 1. Page-specific loading and document lists

`src/services/pages/workspace-data.js` selects the data required by each authorized page. MongoDB queries live in `src/models/workspace-queries.js`, while the EJS page controller selects views and handles HTTP responses. The separation keeps query construction out of templates and preserves the existing MVC/service boundaries.

The invoice, quotation, proforma and delivery-challan lists now show **50 records per page**. Records have a deterministic newest-first order, with MongoDB `_id` as the tie-breaker. Previous and Next retain the current criteria, and an out-of-range page is clamped to the last available page. Empty results show an empty state without an invalid page range.

Search and filters are evaluated by the server across the complete matching collection:

- Search covers the saved document number, customer name, title and business-product name. Search text is literal; characters such as `[` and `*` are escaped before regex construction.
- Status and product selections submit the form and return to page 1. Text search submits with Search or Enter. Clear the text and select the All options to remove filters.
- The overdue filter uses the same Indian business date, paid amount and oldest-installment allocation as the displayed status. A stored `sent` or `partially_paid` status filter keeps the Phase 1 behavior even when the displayed status is overdue.
- Query parameters are validated scalar values inside fixed query shapes. Every query still includes the authorized organization and document kind.

List projections exclude full item arrays, notes, addresses, bank details, images and other large snapshots. A preview, payment, email or deletion page loads its one complete document. An editor additionally loads its own contact, catalog, format and business-product choices. Team, integrations and backup data are requested only by their respective pages. The internal no-route compatibility loader retains its earlier full shape for existing internal/synthetic-preview callers; normal navigation supplies a route and uses the narrower loader.

#### Full matching CSV export

Export CSV streams **all matching records**, independently of the visible page. Its columns, financial helpers, UTF-8 BOM, quoting and formula-prefix protection are retained. Clicking Export also respects search text currently entered in the form, even before pressing Search. A filtered empty result produces the CSV header only. The cursor closes on completion, failure or response cancellation.

The page URLs accept `q`, `status`, `product` and `page`; `download=csv` selects the authenticated export. For example:

```text
/workspace/ORGANIZATION_ID/invoices?q=ACME&status=overdue&page=2
/workspace/ORGANIZATION_ID/invoices?q=ACME&status=overdue&download=csv
```

The existing **`GET /api/documents` response remains a full array**. The page pagination does not silently change that API contract.

#### Overview totals and indexes

The overview streams projected records in bounded batches and retains only the needed recent/pending rows. Counts, received/outstanding amounts, six-month totals and pending installment counts still cover all relevant records. Shared calculation functions preserve legacy paid-status fallbacks and installment allocation. No financial history is rewritten.

Startup adds organization/date, organization/kind/date and organization/ID indexes for these read paths. The implementation reduces the amount of data retained and transferred to a page, but the overview still scans relevant projections to compute complete totals. Literal substring search, counts and deep offset pages can still require substantial work on very large datasets.

### 2. Backup inventory and verification

`listBackupMetadata()` reads published snapshot directories, validates manifest shape and private file properties, and checks the snapshot file size. It does **not** read the complete Extended JSON file or calculate its checksum. Completed snapshot directories are published atomically, so an in-progress temporary backup is not advertised as a completed snapshot.

The Backups page, scheduler initialization and **`GET /api/backups`** use this inexpensive inventory. Listed entries explicitly return:

```json
{
  "verified": false,
  "verification": "on_download"
}
```

This is a deliberate metadata contract clarification. Consumers must not interpret a successful inventory request as evidence that snapshot contents have just been verified.

Snapshot creation, explicit full listing in database tooling, manifest access, download and restore keep their complete validation. The download path rejects checksum mismatches, including tampering that leaves the file size unchanged. Retention still uses the fully verified inventory. Normal workspace navigation does not invoke either inventory method.

### 3. Renewable email claims and recovery

Every claimed outbox message receives a new UUID `claim_token`. A worker write must match the message ID, token, `sending` status and an **unexpired** lease. Missing tokens fail closed. These guards cover payload preparation, payment-link resolution, eligibility holds, first transport, reset expiry, success/failure, unsafe retries and claim release.

| Worker setting                  | Default behavior                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Claim lease                     | Five minutes                                                                                    |
| Heartbeat                       | Renew every 100 seconds during asynchronous preparation and provider transport                  |
| Durable claim/write timeout     | Ten seconds, with majority acknowledgement for nontransactional claim and delivery-state writes |
| Worker shutdown grace           | Up to 20 seconds in the normal HTTP runtime                                                     |
| Forced claim release            | A bounded release attempt; if it cannot reach MongoDB, the persisted lease expires normally     |
| Uncertain provider retry window | The existing 23-hour local safety window is retained                                            |

A stale worker cannot overwrite a delivery recovered by another worker, even when its HTTP success or failure arrives late. Renewal failure stops further local preparation/dispatch and aborts supported HTTP transport. Expired legacy `sending` rows, including legacy rows whose `lease_until` is null or missing, receive a fresh token when reclaimed. An email lease index is created at startup; no bulk rewrite of the queue is required.

The provider idempotency key remains tied to the outbox message. **A new worker claim keeps the same provider idempotency key.** After first transport is durably marked, retries also preserve the frozen request; preparation can still update an unattempted payload. An uncertain attempted delivery keeps its frozen request and original first-attempt marker. Resend's concurrent-idempotent-request conflict is retryable with that same request/key; a mismatched idempotent request is terminal. The Phase 1 cancellation cutoff remains: cancellation holds unattempted invoice/payment messages, while a transport already accepted by the provider cannot be recalled.

`await mailer.stop({ graceMs })` immediately prevents new claims. The current delivery may finish during grace. On expiry, the worker aborts its local wait/transport and tries to release its owned claim. An unattempted message becomes eligible for later preparation; an attempted message preserves its frozen payload and delay before retry. Repeated stop calls share the same shutdown and cannot restart the stopped worker instance.

These mechanisms fence database state and preserve provider retry identity. They cannot promise exactly one external HTTP request under every crash/network scenario. Timers also depend on the Node.js event loop; long synchronous work can delay renewal. Keep worker host clocks synchronized and use the coordinated upgrade procedure below.

### 4. Readiness, diagnostics and shutdown

#### Monitoring endpoints

The existing **`GET /api/health`** contract is preserved. An unauthenticated liveness probe receives `{ "ok": true }` without a database dependency.

The new **`GET /api/ready`** is also available without authentication. A successful response is:

```json
{
  "ok": true,
  "ready": true,
  "state": "ready",
  "checks": { "database": "up", "recovery": "clear" }
}
```

Readiness returns HTTP 503 during startup, database unavailability, an outstanding recovery review, draining or shutdown. Non-ready responses include `Retry-After: 5`. Each ready-state probe performs a current MongoDB ping and reads the recovery marker within a combined **1,500 ms deadline**. Concurrent probes share an in-flight check; later probes do not reuse a cached successful result. A probe in progress cannot turn healthy after draining begins.

Use readiness for traffic routing and liveness to detect whether the HTTP process is responding. Readiness does not inspect live payment/email providers or the contents of backups.

#### Structured request diagnostics

Responses include a server-generated UUID in **`X-Request-ID`**. Unexpected API errors return a generic message and the request ID; unexpected EJS error pages show the support reference. Incoming request IDs are ignored.

The structured stdout logger records allowlisted events and fields such as time, request ID, method, registered route template, status, duration, lifecycle state and safe error class/code. It does not serialize request bodies, headers, queries, actual URLs, route parameter values, credentials, connection strings, error messages or stacks. Invalid enum validation responses no longer reflect arbitrary submitted values. A failing log sink cannot change a committed payment or response.

Request completion/abort, readiness changes, startup failures, email/backup failures and shutdown events use the same logger. No external log collector, alerting dashboard or monitoring account is configured by this source release.

#### Graceful process shutdown

On SIGTERM/SIGINT the server marks readiness as draining, stops new email claims and scheduled backups, rejects new business requests, and lets already accepted requests and the active email finish. It closes MongoDB after accepted HTTP work and worker cleanup have settled.

The overall shutdown deadline is **30 seconds**. Normal completion exits with code 0. A stuck operation at the deadline closes connections, logs the timeout and exits with code 1 from the production entry point. A forced stop cannot guarantee completion of a request already accepted by an external provider; durable email recovery follows the claim rules above.

### 5. Mobile navigation

The mobile drawer has a visible close button, Escape handling and outside-click dismissal. It moves focus into the drawer when opened, traps keyboard focus within it, marks the background inert, locks background scrolling and restores the prior focus/scroll behavior when closed. ARIA state follows visibility. Navigation, business switching and returning to a desktop viewport reset the drawer correctly.

Document filters and pagination wrap within a 390-pixel viewport. Wide document tables scroll within their own container.

### 6. Explicit local draft controls

For an unsaved document, **Start fresh** opens a confirmation. Confirming removes only that draft's local and recovery copies, invalidates its old contact-return handoff and creates a new blank draft identity. Cancelling the confirmation leaves all entries intact.

For an existing document, **Discard unsaved changes** reloads the current saved version. It does not delete or change the saved document, receipts or other drafts.

An unresolved creation request is protected in memory and storage. Start fresh cannot erase its request ID, including through a direct activation of the confirmation control. Resolve it through **Retry save** first. Storage failures, corrupted draft state or a mismatched draft identity fail closed. A creation conflict continues to retain entered values and the link to the document already saved by that request.

### Upgrade from Phase 1

1. Use the complete 2.2.0 project. Keep your private `.example.env` values and persistent data/backup directories outside the source replacement operation. The distributed template contains blank credentials and continues to load directly; no `.env` file or rename is required.
2. Stop all older server/email-worker processes before starting 2.2.0. Older workers write by message ID without the new claim token; do not run them alongside the new workers.
3. Install with `npm ci`, start against the existing MongoDB replica set and allow startup to create the additional query/lease indexes. Review index creation time on a large existing collection during the maintenance window.
4. Replace browser assets with the matching server version and refresh existing tabs. Do not combine a newer backend with cached older editor assets during the upgrade.
5. Check `/api/ready`, sign in and confirm the selected organization's list, overview and an existing document. Retain the existing recovery procedure after a database restore.

No new configuration variables or provider credentials are introduced. Existing Phase 1 revision/request-ID API requirements remain in effect. The only deliberate existing response clarification here is backup-list metadata's verification status; the new readiness endpoint and page query parameters are additive.

### Verification and remaining scope

See [Verification](VERIFICATION.md) for the final combined test counts, browser coverage, controlled payload measurement and test commands. The release was checked with disposable native MongoDB replica sets, the real Express/EJS application and authenticated Chromium. Provider tests use controlled responses; no live payment, message, account migration or hosting deployment was performed.

This phase improves the reviewed read paths and worker/operational behavior. It does not claim a large-scale concurrency benchmark. Overview aggregation and substring search still inspect matching data; deep pagination still uses offsets; page-specific editor/management choices can still grow with their own collections. The existing shared write-transaction lock and process-local authentication rate limiter remain broader scaling considerations.

At the end of Phase 2, customer ledgers, reminders and automatic recurring invoice generation were later-phase work. They are now included in [Phase 3](#v2.3.0). A larger concurrency redesign remains separate work. Recurring-period pricing already available in the application is retained.

#### Design references

- [MongoDB query optimization](https://www.mongodb.com/docs/manual/core/query-optimization/)
- [MongoDB indexes and sort order](https://www.mongodb.com/docs/manual/tutorial/sort-results-with-indexes/)
- [Resend idempotency keys and retry behavior](https://resend.com/docs/dashboard/emails/idempotency-keys)

<a id="v2.1.0"></a>

## 2.1.0 — Correctness fixes

### Summary

This release fixes the reviewed customer handoff, stale document updates, duplicate creation after a lost response, receipt amount/date validation, gateway business dates, and cancellation of unattempted invoice emails.

**Hindi:** Contact ab sirf usi draft mein select hoga jahan se add kiya tha. Purani copy save karne par conflict dikhega aur aapke unsaved changes screen par rahenge. Network error ke baad **Retry save** wahi request check karega. Future manual receipts aur ek paise se chhoti amounts reject hongi. Gateway receipts ki date India timezone mein hogi.

Existing unversioned documents are read as revision zero until their first update. New documents expose a `version`, and full-document and installment-plan API updates must send that version. New browser drafts send a persisted `requestId`; a retry returns the same saved document. See recovery behavior and verification scope.

### Details

Release: **2.1.0**. The application remains Express MVC, EJS, JavaScript and native MongoDB. This release implements the six Phase 1 areas from the review. Existing document kinds, pricing calculations, saved snapshots, payment providers and configuration filenames remain part of the application.

### What changed for users

| Area                | Updated behavior                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact selection   | A newly created contact returns only to the exact editor/draft that requested it. Standalone Contacts saves cannot replace the buyer in another invoice. The handoff is single-use and expires.                                                                        |
| Concurrent edits    | A stale save shows a conflict without discarding the entries on the screen. Open the latest saved version in another tab, compare the entries and deliberately apply the changes still needed. The full-document editor also offers an unsaved JSON recovery download. |
| Uncertain creation  | The first creation payload and its request ID are saved before the HTTP request. If its result is unknown, the editor retains the entries and offers **Retry save**. Retrying after a reload checks the same request and returns the same invoice.                     |
| Manual receipts     | New receipt dates cannot be after the current Indian business day. Valid historical receipts remain supported. Receipt amounts must be at least INR 0.01 and represent whole paise.                                                                                    |
| Gateway dates       | New Razorpay and Cashfree receipts derive their receipt date in `Asia/Kolkata`. The original verified provider instant is retained as `providerPaidAt` when supplied.                                                                                                  |
| Cancellation emails | Cancelling an invoice holds its invoice/payment emails whose first transport has not started. The worker checks the current document again before starting delivery.                                                                                                   |

#### Browser recovery

An unknown save result is different from a validation rejection. After a network failure or uncertain server response, the new-document form is temporarily locked while **Retry save** resolves the original payload. It does not silently generate a new request ID. A confirmed validation rejection leaves the form editable for correction.

If a copied tab tries to reuse an already committed request ID with different fields, the server returns a conflict and a linkable reference to the saved document. The original entries remain available for comparison. If that draft was subsequently deleted, the old request is rejected instead of recreating it.

Browser session storage must be available and have enough space to retain a new draft's save request. If storage is blocked or full, the editor explains the issue and sends no creation request. This prevents an unsafe save that cannot be identified after a reload. Existing pending drafts are retained across refreshes within that browser session. This is browser recovery, not a shared cloud autosave service.

### API contract

#### Create: `POST /api/documents`

The normal document fields are unchanged. The updated browser also supplies a UUID `requestId`:

```json
{
  "requestId": "a054c81d-5151-4c35-a4e5-e02083136ab7"
}
```

This is an additional field in the complete document request, not the complete request body.

| Situation                                                | Response                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| First successful request                                 | `201`, saved document with `version: 1`.                                                                                          |
| Same organization, request ID and parsed document fields | `200`, the current version of that same saved document. No new number or automatic email.                                         |
| Same request ID with different document fields           | `409`, code `DOCUMENT_REQUEST_CONFLICT`; saved document identity is included if still available and within the same organization. |
| Previously created draft has been deleted                | `409`, code `DOCUMENT_REQUEST_CONFLICT`; no recreation.                                                                           |
| Request fails before commit                              | No request record, document or sequence change is committed. The corrected request may reuse its ID.                              |

Object property ordering does not affect the request hash; meaningful array order does. Request IDs are scoped to an organization and normalized to lowercase. Matching retries return the current saved document so later legitimate edits are not overwritten by a frozen creation response.

`requestId` remains optional for older API integrations. Requests that omit it retain the original create-on-each-call behavior and **do not have retry deduplication**. Integrations should send and retain a UUID for each intended new document. Automatic retries must reuse the exact same business fields and ID.

#### Update: `PUT /api/documents/:id`

Full-document updates must include the numeric `version` from the last document response:

```json
{
  "version": 3
}
```

This is an additional field in the complete update body. A matching update returns the incremented version. Missing or stale versions return `409` with code `DOCUMENT_VERSION_CONFLICT`. Invalid version types return `400`. This requirement intentionally closes the old unguarded-update path; integrations must read the latest document and include its version.

Do not fetch a fresh revision and blindly attach it to an old full document body. Reconcile the actual latest fields with the user's intended changes. The browser conflict flow keeps the old form available and opens a fresh editor for this purpose.

Every internal document change advances the revision too, including receipt/void balance updates, installment changes and conversion links. Receipt, void, finalization and conversion actions keep their existing request formats and load the current document inside their transaction before saving.

The dedicated `PUT /api/documents/:id/installments` endpoint replaces a complete plan, so it also requires `{ "plan": ..., "version": ... }`. A stale plan replacement or removal returns the same `DOCUMENT_VERSION_CONFLICT` without changing the current schedule or its history. The browser captures the revision when the schedule editor or removal confirmation opens; refreshing other payment information cannot silently rebase an unsaved plan.

#### Receipts

New manual receipts must use `paidOn` no later than the injected application clock's `Asia/Kolkata` calendar date. The existing date range and calendar validation still apply. Future installment due dates remain valid because schedules describe planned collections.

Amount validation rejects fractional paise and zero-after-rounding amounts, while normalizing ordinary floating-point noise such as `0.1 + 0.2`. Accepted amounts are normalized before receipt idempotency comparison. A previously saved matching receipt returns before the new-date check, so a clock adjustment does not invalidate an existing successful retry.

Public receipt input cannot claim to be a verified provider receipt by adding `providerPaidAt`. Only the trusted gateway callback supplies that metadata. A malformed provided gateway timestamp fails before crediting; a missing timestamp retains the existing application-clock fallback. Existing stored receipt dates are not rewritten.

#### Email cancellation boundary

Cancellation holds invoice, payment-received, payment-paid and payment-failed messages that have no first transport timestamp. An eligible queued or claimed message is held even if it was created before this release. Held cancellation messages cannot be released through the ordinary retry action while the document remains cancelled.

The worker checks eligibility before preparation and again in the transaction that records the first transport timestamp. Cancellation that commits before this boundary prevents the first provider request. Cancellation during PDF preparation is covered, including preparation that subsequently fails.

An email already accepted by the provider, in flight, or previously attempted with an unknown outcome cannot be recalled. Such retries retain the exact saved request and provider idempotency key; they do not regenerate the document, attachment, sender or payment link. Earlier attempted messages with incomplete frozen delivery data remain held for review instead of being rewritten under the old key.

### Existing database and deployment

1. Keep the existing database connection and private configuration values. The distributed `.example.env` remains a blank credential template and is still loaded directly; hosting environment variables take precedence.
2. Install the updated application dependencies with `npm ci` and restart the updated server. Deploy browser assets and backend together. Existing open editor tabs should be refreshed before further edits.
3. Startup creates the `document_requests` collection and its unique index. Existing unversioned documents are exposed as `version: 0` and upgraded on their first guarded save; no bulk rewrite of financial history is required.
4. Full application backups include request records, document versions and indexes. Restore continues to use an empty target and the existing recovery hold. Old backups without request records remain readable, but cannot reconstruct request histories that did not exist in that backup.

Do not run older application code alongside this release: an old writer does not participate in document revision checks. Use a coordinated application restart for the upgrade. Existing application startup, replica-set requirements and database recovery instructions remain in [Deployment](DEPLOYMENT.md) and [Migration](MIGRATION.md).

### Verification

Focused regression tests are included:

- `tests/editor-state.test.js`: contact handoff ownership/single use, storage failures, revision-aware draft restoration and persisted creation requests.
- `tests/payment-validation.test.js`: minimum/whole-paise amounts, normal decimal noise, Indian business dates and untrusted provider metadata.
- `tests/integration/document-writes.test.js`: creation replay across instances, one number/email, conflicting bodies, failed creation, deleted drafts, stale edits, ledger revision changes, legacy documents and stale installment replacement/removal.
- `tests/integration/payment-correctness.test.js`: native MongoDB receipt/date boundaries, historical retries and both gateway timestamp paths.
- `tests/integration/email-cancellation.test.js`: queued/cancelled eligibility, cancellation during preparation, transport boundary, exact uncertain retries and password reset preservation.

Run the included source, unit and native MongoDB checks as described in [Verification](VERIFICATION.md). Browser acceptance checks cover standalone contact creation, intended contact return, two-editor conflicts, a lost successful response followed by reload/retry, corrected validation input, creation conflicts, storage failure and a real one-paise manual receipt. Installment browser checks cover two-tab plan conflicts, history refresh during editing and stale plan removal.

### Later phases

At the time of the 2.1.0 release, page-specific queries, backup-navigation performance, the full worker lease redesign, readiness/logging, the mobile menu and draft start-fresh controls were deferred. They are now implemented in [Phase 2, release 2.2.0](#v2.2.0), which includes all Phase 1 fixes.

Customer ledgers, reminders, automatic recurring invoice generation and a broader high-volume concurrency redesign remain later-phase work. Existing recurring-period pricing remains available; it is separate from automatic recurring invoice generation.
