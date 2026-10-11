# Phase 2 — performance, worker reliability and usability

Release: **2.2.0**. This is the complete EJS, JavaScript, Express MVC and native MongoDB application, including the [Phase 1 correctness fixes](PHASE-1.md). It implements the next six areas from the project review. The existing document kinds, pricing, financial locks, receipt rules, saved snapshots and provider integrations remain available.

## Changes at a glance

| Area              | Implemented behavior                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page loading      | Each normal workspace route loads its own dependencies. Document lists contain 50 projected records per page; individual document pages fetch the selected full document.                      |
| Backup navigation | Normal workspace pages do not inspect backups. The inventory reads metadata without re-reading complete snapshot contents. Full verification remains on download, manifest access and restore. |
| Email worker      | Unique claim tokens, lease renewal, guarded writes, stale-claim recovery and bounded draining protect concurrent workers and interrupted deliveries.                                           |
| Operations        | Database/recovery readiness, safe structured logs, request IDs and graceful process shutdown are integrated into the real server entry point.                                                  |
| Mobile navigation | A dismissible drawer manages focus, keyboard navigation, background interaction and scrolling.                                                                                                 |
| Draft controls    | Start fresh and Discard unsaved changes are explicit, confirmed actions. Unresolved creation requests remain protected until Retry save resolves them.                                         |

## 1. Page-specific loading and document lists

`src/services/pages/workspace-data.js` selects the data required by each authorized page. MongoDB queries live in `src/models/workspace-queries.js`, while the EJS page controller selects views and handles HTTP responses. The separation keeps query construction out of templates and preserves the existing MVC/service boundaries.

The invoice, quotation, proforma and delivery-challan lists now show **50 records per page**. Records have a deterministic newest-first order, with MongoDB `_id` as the tie-breaker. Previous and Next retain the current criteria, and an out-of-range page is clamped to the last available page. Empty results show an empty state without an invalid page range.

Search and filters are evaluated by the server across the complete matching collection:

- Search covers the saved document number, customer name, title and business-product name. Search text is literal; characters such as `[` and `*` are escaped before regex construction.
- Status and product selections submit the form and return to page 1. Text search submits with Search or Enter. Clear the text and select the All options to remove filters.
- The overdue filter uses the same Indian business date, paid amount and oldest-installment allocation as the displayed status. A stored `sent` or `partially_paid` status filter keeps the Phase 1 behavior even when the displayed status is overdue.
- Query parameters are validated scalar values inside fixed query shapes. Every query still includes the authorized organization and document kind.

List projections exclude full item arrays, notes, addresses, bank details, images and other large snapshots. A preview, payment, email or deletion page loads its one complete document. An editor additionally loads its own contact, catalog, format and business-product choices. Team, integrations and backup data are requested only by their respective pages. The internal no-route compatibility loader retains its earlier full shape for existing internal/synthetic-preview callers; normal navigation supplies a route and uses the narrower loader.

### Full matching CSV export

Export CSV streams **all matching records**, independently of the visible page. Its columns, financial helpers, UTF-8 BOM, quoting and formula-prefix protection are retained. Clicking Export also respects search text currently entered in the form, even before pressing Search. A filtered empty result produces the CSV header only. The cursor closes on completion, failure or response cancellation.

The page URLs accept `q`, `status`, `product` and `page`; `download=csv` selects the authenticated export. For example:

```text
/workspace/ORGANIZATION_ID/invoices?q=ACME&status=overdue&page=2
/workspace/ORGANIZATION_ID/invoices?q=ACME&status=overdue&download=csv
```

The existing **`GET /api/documents` response remains a full array**. The page pagination does not silently change that API contract.

### Overview totals and indexes

The overview streams projected records in bounded batches and retains only the needed recent/pending rows. Counts, received/outstanding amounts, six-month totals and pending installment counts still cover all relevant records. Shared calculation functions preserve legacy paid-status fallbacks and installment allocation. No financial history is rewritten.

Startup adds organization/date, organization/kind/date and organization/ID indexes for these read paths. The implementation reduces the amount of data retained and transferred to a page, but the overview still scans relevant projections to compute complete totals. Literal substring search, counts and deep offset pages can still require substantial work on very large datasets.

## 2. Backup inventory and verification

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

## 3. Renewable email claims and recovery

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

## 4. Readiness, diagnostics and shutdown

### Monitoring endpoints

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

### Structured request diagnostics

Responses include a server-generated UUID in **`X-Request-ID`**. Unexpected API errors return a generic message and the request ID; unexpected EJS error pages show the support reference. Incoming request IDs are ignored.

The structured stdout logger records allowlisted events and fields such as time, request ID, method, registered route template, status, duration, lifecycle state and safe error class/code. It does not serialize request bodies, headers, queries, actual URLs, route parameter values, credentials, connection strings, error messages or stacks. Invalid enum validation responses no longer reflect arbitrary submitted values. A failing log sink cannot change a committed payment or response.

Request completion/abort, readiness changes, startup failures, email/backup failures and shutdown events use the same logger. No external log collector, alerting dashboard or monitoring account is configured by this source release.

### Graceful process shutdown

On SIGTERM/SIGINT the server marks readiness as draining, stops new email claims and scheduled backups, rejects new business requests, and lets already accepted requests and the active email finish. It closes MongoDB after accepted HTTP work and worker cleanup have settled.

The overall shutdown deadline is **30 seconds**. Normal completion exits with code 0. A stuck operation at the deadline closes connections, logs the timeout and exits with code 1 from the production entry point. A forced stop cannot guarantee completion of a request already accepted by an external provider; durable email recovery follows the claim rules above.

## 5. Mobile navigation

The mobile drawer has a visible close button, Escape handling and outside-click dismissal. It moves focus into the drawer when opened, traps keyboard focus within it, marks the background inert, locks background scrolling and restores the prior focus/scroll behavior when closed. ARIA state follows visibility. Navigation, business switching and returning to a desktop viewport reset the drawer correctly.

Document filters and pagination wrap within a 390-pixel viewport. Wide document tables scroll within their own container.

## 6. Explicit local draft controls

For an unsaved document, **Start fresh** opens a confirmation. Confirming removes only that draft's local and recovery copies, invalidates its old contact-return handoff and creates a new blank draft identity. Cancelling the confirmation leaves all entries intact.

For an existing document, **Discard unsaved changes** reloads the current saved version. It does not delete or change the saved document, receipts or other drafts.

An unresolved creation request is protected in memory and storage. Start fresh cannot erase its request ID, including through a direct activation of the confirmation control. Resolve it through **Retry save** first. Storage failures, corrupted draft state or a mismatched draft identity fail closed. A creation conflict continues to retain entered values and the link to the document already saved by that request.

## Upgrade from Phase 1

1. Use the complete 2.2.0 project. Keep your private `.example.env` values and persistent data/backup directories outside the source replacement operation. The distributed template contains blank credentials and continues to load directly; no `.env` file or rename is required.
2. Stop all older server/email-worker processes before starting 2.2.0. Older workers write by message ID without the new claim token; do not run them alongside the new workers.
3. Install with `npm ci`, start against the existing MongoDB replica set and allow startup to create the additional query/lease indexes. Review index creation time on a large existing collection during the maintenance window.
4. Replace browser assets with the matching server version and refresh existing tabs. Do not combine a newer backend with cached older editor assets during the upgrade.
5. Check `/api/ready`, sign in and confirm the selected organization's list, overview and an existing document. Retain the existing recovery procedure after a database restore.

No new configuration variables or provider credentials are introduced. Existing Phase 1 revision/request-ID API requirements remain in effect. The only deliberate existing response clarification here is backup-list metadata's verification status; the new readiness endpoint and page query parameters are additive.

## Verification and remaining scope

See [Verification](VERIFICATION.md) for the final combined test counts, browser coverage, controlled payload measurement and test commands. The release was checked with disposable native MongoDB replica sets, the real Express/EJS application and authenticated Chromium. Provider tests use controlled responses; no live payment, message, account migration or hosting deployment was performed.

This phase improves the reviewed read paths and worker/operational behavior. It does not claim a large-scale concurrency benchmark. Overview aggregation and substring search still inspect matching data; deep pagination still uses offsets; page-specific editor/management choices can still grow with their own collections. The existing shared write-transaction lock and process-local authentication rate limiter remain broader scaling considerations.

At the end of Phase 2, customer ledgers, reminders and automatic recurring invoice generation were later-phase work. They are now included in [Phase 3](PHASE-3.md). A larger concurrency redesign remains separate work. Recurring-period pricing already available in the application is retained.

### Design references

- [MongoDB query optimization](https://www.mongodb.com/docs/manual/core/query-optimization/)
- [MongoDB indexes and sort order](https://www.mongodb.com/docs/manual/tutorial/sort-results-with-indexes/)
- [Resend idempotency keys and retry behavior](https://resend.com/docs/dashboard/emails/idempotency-keys)
