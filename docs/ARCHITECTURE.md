# Architecture

This describes release **2.4.0 (Phase 4)**. The MVC migration and Phase 1–3 document revision, receipt, ledger, automation, worker and delivery guarantees below continue to apply.

## Request flow and ownership

This is one Express application. EJS renders the initial HTML, and browser ES modules handle interactions and call the same-origin JSON API. Page URLs support navigation, refresh and bookmarks without a React application or frontend build.

`server.js` owns the process lifecycle. `src/app.js` assembles the backend and page routes. Routes map URLs to controllers; controllers validate and authorize HTTP inputs, call services and return JSON or select an EJS view. Services implement the business workflow. Models read and write MongoDB. EJS templates format authorized data and contain no database calls.

| Layer       | Main entry                                                      | Boundary                                                                                    |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Process     | `server.js`, `src/services/operations/http-runtime.js`          | Loads configuration; owns the HTTP server, mail polling, backup scheduling and shutdown.    |
| Composition | `src/app.js`, `src/services/backend.js`                         | Constructs and injects database, authentication and provider services.                      |
| Routes      | `src/routes/api.js`, `src/routes/pages.js`                      | Explicit API and page dispatch; no business calculations.                                   |
| Controllers | `src/controllers/api/`, `src/controllers/pages/`                | Request validation, access checks, workflow invocation and response/view selection.         |
| Services    | `src/services/workspace-service.js` and feature folders         | Numbering, snapshots, payment ledgers, lifecycle rules and provider state transitions.      |
| Models      | `src/models/repositories.js`, `src/models/workspace-queries.js` | Native document queries, projections and updates; receives the active transaction session.  |
| Views       | `views/`                                                        | Escaped EJS output, layouts, partials and form controls.                                    |
| Browser     | `public/js/`                                                    | DOM interactions, API calls, preview, downloads and draft state.                            |
| Shared      | `shared/`                                                       | Pure calculations, document structures, identity and PDF composition used in both runtimes. |

`src/services/backend.js` is the composition root for backend features. It retains shared service wiring so HTTP controller modules do not create independent database clients, payment adapters or mail queues. Domain controllers are split by organizations, contacts, documents, payments, catalog, products, formats, GST, integrations and operations. GST provider selection lives in `src/services/integrations/gst/gst-config.js`, and `src/middleware/api-errors.js` maps validation, service and infrastructure errors to API responses.

## Native MongoDB model

The database uses native BSON documents, nested objects and arrays. It does not wrap every SQLite row in a JSON string or emulate SQL tables in memory. Business IDs remain the existing application IDs, so URLs, snapshots, payment references and import relationships can survive migration.

| Collections                                                         | Data                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `organizations`, `workspace_settings`                               | Organization identities and separate workspace branding.                                                              |
| `customers`, `catalog`, `business_products`, `formats`              | Organization-scoped editable master records.                                                                          |
| `documents`                                                         | Financial/shipping records, line items, totals, installment plan and saved snapshots.                                 |
| `document_requests`                                                 | Organization-scoped creation request IDs, input hashes and the resulting document ID.                                 |
| `sequences`                                                         | Number counters by organization, kind and Indian financial year.                                                      |
| `payments`, `document_events`                                       | Receipt ledger and retained document activity.                                                                        |
| `auth_users`, `auth_sessions`, `auth_password_resets`, `auth_audit` | Account state, hashed session/reset tokens and audit records.                                                         |
| `auth_rate_limits`                                                  | Atomic per-scope/client request counters with server-clock windows and TTL cleanup.                                   |
| `email_outbox`                                                      | Delivery attempts, payloads, recipient snapshots and retry/lease state.                                               |
| `payment_reminder_policies`                                         | One versioned, opt-in reminder policy per organization; rules are kept with their owning policy.                      |
| `recurring_invoice_schedules`                                       | Bounded immutable commercial template, references, recurrence anchor, next occurrence and versioned management state. |
| `recurring_invoice_occurrences`, `recurring_invoice_events`         | Separate growing generation results and management audit history, retained after draft deletion.                      |
| `online_*`, `cashfree_*`                                            | Provider links, verified receipts, event deduplication, failures and Cashfree order mapping.                          |
| `workspace_metadata`                                                | Database schema and initialization marker.                                                                            |
| `transaction_locks`                                                 | Coordination of multi-record workspace transactions.                                                                  |
| `ops_recovery_state`                                                | Restore/import hold and operator acknowledgement.                                                                     |

Document line items and historical identity/format snapshots are embedded because they belong to a particular saved document. Growing payment, provider-event and audit histories are separate records. Updating the current customer, organization, business product or format does not mutate old snapshots.

Repositories apply organization filters for scoped lists. Request-level access checks also resolve a record's organization before returning or modifying it. A guessed document ID does not bypass the requesting staff member's organization assignment.

## Transactions and concurrency

One `MongoClient` is shared per server process. The Node driver's connection pool is reused; there is no client-per-request pattern. Pool settings remain at driver defaults until deployment measurements show a need to change them.

The application requires a replica set or sharded cluster. Multi-record operations use snapshot reads, majority writes and the primary. An `AsyncLocalStorage` context passes the same session through nested repository calls, so nested business operations remain in the same transaction.

Multi-record business writes select one of 32 fixed organization stripes before reading the records involved. `db.transaction(action, { organizationId })` uses that stripe; the default exclusive workspace transaction takes all stripes plus the original `workspace-writes` row in a stable order. Same-business writes and hash collisions serialize, while transactions assigned different stripes may overlap. A write conflict retries against a fresh snapshot. Organization settings/prefix checks, account administration, seeding and restore remain exclusive.

`src/config/transaction-scopes.js` defines the fixed protocol. Nested calls inherit the parent session; explicit cross-organization or workspace expansion under a scoped parent is rejected. `src/services/transaction-ownership.js` reloads saved ownership inside the selected scope. Receipt voids derive their scope from the persisted parent invoice, preserving legacy receipts without their own organization field while rejecting conflicting ownership. Missing lock rows fail the write. Stop all older writers before upgrading; v2.3 processes do not participate in the new stripe protocol. This is a bounded coordination improvement, not a production throughput result.

Indexes reinforce the business rules: unique document numbers, per-organization nonempty SKU/product codes, one default format per organization, receipt request IDs, provider receipt/event identifiers and one active payment link per document. Authentication email is case-insensitively unique. Session/reset collections have expiry indexes in addition to explicit expiry checks during access.

Provider HTTP requests run outside retryable MongoDB transactions. Link reservation and receipt verification are recorded separately, so an automatically retried database transaction does not repeat an external payment request. Unknown provider creation outcomes remain visible for review instead of triggering a blind duplicate creation.

Phase 1 adds optimistic document revisions as well as transaction locking. Every saved document change, including receipt balance updates and conversions, increments `version`; a full-document update must supply the revision shown to the editor. A database compare-and-swap verifies that revision again and never upserts an update into a missing record. Documents without a stored revision read as version zero and acquire version one on their first guarded update.

New browser drafts persist an exact creation payload and UUID request ID before sending. `document_requests` has a unique `(organizationId, requestId)` index. Its record is committed in the same transaction as the document, sequence and automatic email. Matching retries return the existing document, while conflicting bodies receive a `409`. Request records remain after eligible draft deletion so old retries cannot recreate a deleted invoice. Full MongoDB snapshots include these records and their index.

Invoice cancellation and the email worker's first transport marker use the same transaction coordination. Unattempted invoice/payment emails are held when cancellation commits first. The worker checks current document eligibility even when no payment-link resolution is needed. Once transport has started, retries preserve the original body, attachment, sender and provider idempotency key; already attempted deliveries cannot be recalled by this application.

### Email worker ownership in Phase 2

Each email claim atomically assigns a fresh UUID `claim_token` and a five-minute `lease_until`. The worker renews its lease every 100 seconds and also checks ownership before critical preparation, transport and completion steps. Worker mutations require the message ID, matching claim token, `sending` state and an unexpired lease. An older worker whose claim has expired or been replaced cannot save a payload or overwrite the newer worker's delivery result. Due queued messages and expired sending claims can be claimed by another instance.

Claims, renewals and other worker mutations outside a transaction use majority write concern and a 10-second operation timeout. Writes already inside a transaction inherit that transaction's options. The shutdown claim-release operation has a shorter three-second timeout. The transport eligibility check and first-attempt marker still share the cancellation transaction, and provider HTTP remains outside retryable transactions.

The claim token changes when ownership changes; the provider idempotency key remains `venturecore-email/<message ID>`. An attempted delivery reuses its saved body, PDF, sender profile and original first-attempt time. The application's existing 23-hour safe retry window and provider review holds still apply. Local cancellation cannot establish whether a provider accepted an interrupted request, so shutdown and recovery do not create a fresh delivery key to resolve an uncertain outcome.

`mailer.stop({ graceMs: 20_000 })` is idempotent. It immediately prevents new claims, allows the current delivery to finish, then aborts local waiting and HTTP work if the grace period expires. An unfinished claim is released only while the stopping worker still owns it. Unattempted work is queued immediately; an attempted, unconfirmed delivery is queued with a one-minute retry delay and its original payload. If MongoDB cannot record the release, the lease expires normally. Deployment must stop all older workers before starting release 2.2.0 workers; see [Deployment and provider setup](DEPLOYMENT.md).

## Preserved document lifecycle

The shared pricing and PDF modules were converted to JavaScript without replacing their business formulas. Financial documents keep INR calculations, per-component rounding, seller registration, GST split, discounts, recurring periods, jewellery breakdown, Indian amount words and saved format selection.

New documents receive a financial-year number when saved. Deleting an eligible draft does not reuse its sequence. A quotation/proforma converts at most once; an invoice may produce a quantity-only delivery challan. Issued documents lock financial fields, receipts reduce balances, and finalization locks further editing. A reasoned receipt void retains the original record and changes the current ledger balance.

Installment schedules store the whole invoice amount in integer paise. Receipt allocation is computed oldest-due-first. A void therefore changes the allocation without deleting schedule or audit history. The schedule is neither an interest calculator nor an automatic debit mechanism.

## EJS and browser responsibilities

`views/layouts/workspace.ejs` supplies navigation and the common shell. Feature views contain real data and forms on the first server response. `public/js/core/` supplies shared API, navigation, image and toast helpers; feature modules own their form and page interactions.

EJS's escaped output is used for user-supplied values. Page data embedded in script elements is serialized with HTML-sensitive characters escaped. Raw template includes and internal icons are controlled application assets, not user-selected template source. Public static mounts are limited to browser assets, shared browser-safe modules and PDF assets; configuration and server files are not static directories.

PDF creation uses the shared PDF definition. Browser download generates a PDF locally; server email attachments use the same document model with server-compatible image/font handling. Long tables, signatures, branding, quantities and tax fields are part of this shared definition.

### Page-specific reads and exports in Phase 2

The page controller passes the requested view and action to `src/services/pages/workspace-data.js`. This service first resolves the user's permitted organization and common shell data, then loads the records needed for that page. Team, integration and backup data are loaded on their respective authorized pages. Ordinary navigation no longer loads every financial document or scans backup contents.

`src/models/workspace-queries.js` supplies projected document queries. Invoice, quotation, proforma and shipping lists display **50 rows per page**, with a count of all matching rows. Search, status and business-product filters run on the server within the authorized organization and document kind. Overdue filtering uses the India business date and the invoice's receipt/installment state. List projections include display names, totals, balances and schedule amounts/dates; they omit line items, addresses, bank details and embedded image snapshots.

CSV download streams **every row matching the same filters**, regardless of the displayed page, using a projected cursor and closing it when the export ends. It exports the existing summary columns, not the full document payload. The existing `GET /api/documents` endpoint continues returning the full authorized document array; page pagination does not change that API contract. The optional internal page-data call without a route also retains its full-data form for existing preview integrations.

The overview streams projections across all invoices and quotations needed for its calculations. Invoice counts, receipts, outstanding balances, overdue counts, open quotations and pending installment counts retain their full scope. The visible recent-document list is limited to six and the pending installment preview to eight; these display limits do not limit the totals. The six-month chart preserves its existing calculation. Editing and previewing fetch the selected full document with organization/kind checks; an editor also loads the master records needed by its controls.

## Phase 3 receivables and automation

The three new API controllers and EJS pages are registered in the existing application. Normal page loading requests these services only for their own feature routes; older workspace screens do not load the ledger, reminder targets or recurring histories. Browser scripts handle controls and call the same authenticated JSON APIs.

### Derived customer ledger

`src/models/customer-ledger-queries.js` performs organization-scoped projected queries and joins receipts through authorized invoice IDs. `src/services/ledger/` applies the existing current invoice/payment helpers, integer-paise arithmetic and dated statement rules. A dedicated read-only snapshot session makes the related invoice/receipt reads consistent without acquiring the shared workspace write lock. There is no new ledger collection and no financial write during a statement or export.

Customer IDs establish identity. Archived contacts remain visible; an absent contact with a stable saved ID uses its saved snapshot. Invoices without a usable ID appear as separate organization metadata. Names never establish an ownership join. Draft/cancelled invoices and their receipts are excluded together. Current invoice status is the explicit statement basis because the existing records do not contain every historical issue/cancellation timestamp.

Actual receipt dates and void timestamps produce credits and reversals. Legacy paid snapshots, missing receipt records or undated events produce notices and unavailable historical balances; the current invoice balance is retained independently. CSV/print includes all matching entries even though the screen normally contains 50 rows. Full totals, sorting and statement assembly still retain relevant projected records; this is not a constant-memory reporting system or a large-scale benchmark.

Phase 4 makes receipt-summary rounding match JavaScript at half-paise and large safe values. Statements omit the redundant receipt-summary join and read actual receipt history once inside the same snapshot. Inactive invoices retain their identity/exclusion semantics while avoiding unnecessary receipt joins.

### Reminder preparation and delivery

`src/services/integrations/email/payment-reminders.js` reads eligible open invoices and oldest-due installment allocation. Policies use the organization ID as `_id`; optimistic versions prevent stale settings from overwriting newer choices. Manual reminder event keys include invoice, installment, due date and Indian business day. Automatic event keys include the selected scheduled occurrence. The existing unique outbox event key prevents concurrent duplicate enqueue for that key.

Automatic policies are separately opt-in and do not inherit `EMAIL_AUTOMATION`. The scheduler queues rules that match the current Indian business date; missed rule dates are not caught up. First-attempt preparation refreshes the saved invoice, balance and PDF. A transaction checks the document fingerprint, policy revision, eligibility and worker ownership again at the first-transport boundary. Changed unpaid data is prepared again; ineligible unattempted messages are held. Attempted uncertain retries retain the frozen request and provider idempotency key under the Phase 2 lease rules.

Phase 4's `src/models/reminder-queries.js` restricts automatic candidates to invoice or installment due dates matching the policy offsets. Separate compound indexes support each branch. Shared eligibility and transaction rechecks still decide what can be queued. A day change ends the obsolete selection pass; the next pass selects the new day. Dashboard totals still cover every eligible target and retain their existing memory/sort limits.

Reminders use existing business email configuration and create no payment-provider link. The first transport cannot be recalled, so a payment after that boundary does not prove the provider stopped delivery. Manual and automatic reminders have distinct identities; an explicitly queued manual reminder can coexist with an automatic rule for the same day.

### Recurring drafts

`src/services/recurring/recurring-invoices.js` stores a frozen commercial template and source/reference identity. `shared/recurrence-dates.js` derives each occurrence from its original anchor, retaining a day-31 or leap-day anchor across short periods. Creation uses a persisted organization-scoped request ID and fingerprint. Management and generation require a reviewed schedule version; explicit generation also identifies its occurrence date.

Generation validates current organization, customer, catalog, format and business-product references, then invokes the existing `workspace.newDocument` calculation and numbering path. It creates a fresh draft without copying receipts, installments, finalization or email/provider state. The draft, unique occurrence record, schedule advancement and audit event commit together. A retained generated occurrence recovers a repeated result even after the draft is deleted. Failure rolls the generation transaction back, then records a visible error without advancing the next occurrence or consuming its number.

Compound unique indexes protect `(organizationId, requestId)` creation identity and `(scheduleId, scheduledDate)` occurrence identity. A partial unique document index protects `(recurringScheduleId, recurringScheduledDate)` as an additional check. Growing occurrence/event histories remain separate from the schedule and use bounded page reads.

### Shared worker and restore boundaries

`src/services/operations/automation-runner.js` runs recurring generation and then reminder scheduling at most once per 60 seconds per process, coalescing overlapping passes. The existing 15-second HTTP-runtime worker poll invokes it before processing email. Each recurring pass takes at most 20 due schedules and one occurrence per schedule, with a persisted 60-second eligibility delay. A feature error is logged with its stage and does not prevent the other scheduler from running. The process must remain running for these jobs; no hosted cron or external queue is installed.

Shutdown immediately prevents further scheduling, waits for accepted generation/enqueue work and retains the existing overall deadline. Database restore disables reminder policies and increments their revisions, pauses unfinished recurring schedules and increments their revisions, clears email claim ownership and keeps queued/uncertain email held. Releasing the global recovery hold does not enable either automation. Completed schedules, occurrence tombstones and history are retained. See [Phase 3](CHANGELOG.md#v2.3.0) for the operator workflow and backlog behavior.

## Accounts and operations

Passwords are hashed and session/reset tokens are stored as hashes. Public signup creates a pending account. Administrators assign organization access; staff cannot use administration, integration-configuration or whole-database backup routes. Production uses secure HTTP-only cookies, origin-aware JSON mutation checks and security headers.

Account limits use shared atomic MongoDB counters with server-clock windows, majority writes and a two-second protection deadline. TTL removes old rows, while the limiter checks expiry itself. Counter writes and known password mismatches do not take financial coordination locks. `TRUST_PROXY` defaults empty; explicit validated proxy peers determine whether Express may use forwarded addresses. IPv4 and mapped IPv6 normalize to the same counter key. Storage failure returns a controlled 503 before credential verification; over-limit requests retain the generic 429 message and retry timing.

`src/services/auth/security.js` provides own session listing/revocation, administrator selected-account revocation and projected, paginated account activity. New sessions have independent UUID identifiers; existing ObjectId sessions remain addressable without exposing token hashes. Mutations verify current actor access and the acting session again inside the exclusive transaction. EJS pages and same-origin browser controls supply confirmations and handle self-sign-out. Activity dates use IST; repeated unsuccessful attempts are sampled, and unknown legacy fields never become open-ended browser data. See [Phase 4](CHANGELOG.md#v2.4.0) for API details and exact limits.

Backups are consistent MongoDB snapshots with indexes, canonical Extended JSON values, a manifest and a SHA-256 digest. Recovery invalidates old sessions/reset links and holds uncertain queued email. Import/restore never merges into a running business database. See [Migration and recovery](MIGRATION.md).

Backup inventory now uses `listBackupMetadata()` for the backup page, `GET /api/backups` and scheduler initialization. It validates the small manifest, private paths, expected files and recorded file size without hashing or parsing every snapshot, and reports `verified: false` with `verification: "on_download"`. Inventory can be read without waiting behind an active snapshot/verification job. Creating a snapshot, obtaining its manifest or data download, explicit verification, retention and restore retain their full content/checksum validation. An inventory row is therefore an available backup candidate, not a new verification result.

### Readiness and request diagnostics

`src/services/operations/readiness.js` separates the existing health response from current workspace readiness. `GET /api/health` keeps its existing contract: unauthenticated requests receive `{ "ok": true }`, while authorized requests retain the provider configuration fields. `GET /api/ready` is public and returns only operational state:

| Condition                                          | HTTP status | Readiness state                     |
| -------------------------------------------------- | ----------- | ----------------------------------- |
| MongoDB responds and recovery is clear             | 200         | `ready`                             |
| MongoDB or the recovery probe fails or times out   | 503         | `unavailable`                       |
| Recovery review is pending                         | 503         | `recovery_required`                 |
| Local initialization, drain or stop is in progress | 503         | `starting`, `draining` or `stopped` |

A normal probe pings MongoDB and reads only the recovery status, with a **1,500 ms total deadline**, operation timeouts and cancellation. Concurrent probes share the in-flight check; later checks do not reuse a cached successful result. Lifecycle state is checked again before returning, so a probe cannot turn ready after draining begins. Non-ready responses include `Retry-After: 5`. Readiness does not test external provider availability, email delivery or backup integrity, and it does not bypass the existing startup recovery hold.

`src/middleware/errors.js` assigns a server-generated UUID to each request and returns it in `X-Request-ID`. Unexpected API server errors use a generic message and include the same `requestId` in their JSON body. The page error path can report through the same service. Diagnostics are idempotent when the synthetic preview wrapper forwards a request into the backend.

`src/services/operations/logger.js` emits JSON records to stdout. Request completion, abortion and failure records include an allowlisted method, registered route template, status, duration and request ID where applicable. Startup, readiness transitions, mail/backup failures and shutdown use the same logger. Only known error classes/codes are retained: request bodies, headers, query strings, actual URLs, credentials, connection strings, error messages, causes and stack traces are excluded. Client-supplied request IDs are ignored, and a failing log sink cannot change the request result. No external log collector is configured by the application.

### Process drain and shutdown

The HTTP runtime stops its 15-second mail polling interval, marks readiness as draining, stops new email claims and stops backup scheduling as soon as SIGTERM or SIGINT is handled. New business requests that reach a draining process receive `503 SERVICE_DRAINING` with `Retry-After: 5`; health/readiness handlers remain exempt from that middleware while the listener is reachable. The server closes its listener and idle connections, lets accepted HTTP requests finish, and awaits the email worker and pending backup work before closing its owned MongoDB connection.

The email worker has its default 20-second drain allowance inside a **30-second overall process deadline**. Repeated shutdown calls share the same work. A successful shutdown exits normally; a stuck operation at the overall deadline closes remaining connections, records `shutdown_timeout` and makes the production entry point exit with code 1. Unexpected process failures are logged using the same redaction rules and initiate shutdown. These durations are code defaults; release 2.2.0 adds no environment variables and continues using `.example.env`.

## Extending the application

Add an API controller and route for a new HTTP operation, put its reusable business decisions in a service, and add repository methods for new database access. Put user-facing markup in an EJS feature view and interaction code in the corresponding browser module. Keep monetary calculations in `shared/` so preview, persisted data and email/PDF output agree.

Do not import server credentials, MongoDB or filesystem modules into `shared/` or `public/`. Do not issue external provider HTTP requests from a transaction callback. When changing an existing financial rule, test the resulting behavior and its retry/locking semantics rather than mirroring private implementation methods.

## Primary references

- [EJS documentation](https://ejs.co/docs/)
- [MongoDB Node.js driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)
- [MongoDB connection pools](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/)
