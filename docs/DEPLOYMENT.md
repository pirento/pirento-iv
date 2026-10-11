# Deployment and provider setup

This guide covers **release 2.5.0 (Phase 7)**, including the shared production preflight, configuration selection, directory indexes and the retained transaction/worker upgrade requirements.

## Node host and database

Deploy this directory as a Node.js application. It is not a static-site upload. Use a host/runtime that supports Node.js 24.5+, outbound HTTPS and MongoDB connectivity, and persistent storage for local backup files. The application itself stores business records in MongoDB.

For a Hostinger Node application or another Node host, configure:

| Setting            | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| Project root       | Directory containing `package.json` and `server.js`.                                 |
| Runtime            | Node.js 24.5+ (24 LTS recommended).                                                  |
| Install            | `npm ci` during preparation; production may use `npm ci --omit=dev` after checks.    |
| Build/check        | `npm run build`. It validates source and EJS; there is no generated frontend bundle. |
| Start              | `npm start` or entry file `server.js`, according to the host's interface.            |
| `NODE_ENV`         | `production`                                                                         |
| `HOST`             | `0.0.0.0` when the platform routes to the process over its network.                  |
| `PORT`             | The port supplied by the host. Default local port is 3001.                           |
| `PUBLIC_APP_URL`   | Exact public HTTPS origin, for example `https://billing.example.com`.                |
| `MONGODB_URI`      | Authenticated Atlas/replica-set connection string.                                   |
| `MONGODB_DATABASE` | The intended application database.                                                   |

Both `npm start` with `NODE_ENV=production` and `npm run start:hostinger` now use the same read-only production preflight before application initialization. `start:hostinger` requires production mode unless the explicit disposable preview mode is selected. Production requires an exact HTTPS origin: no path, user information, query, fragment or trailing slash. For an intentional first deployment into a new database, set `IV_ALLOW_NEW_DATABASE=true` with valid initial administrator credentials, start successfully, then set it back to `false`. Later empty-database selection is refused instead of silently creating a replacement workspace. A recovery hold also prevents startup. Run `npm run check:deployment` to inspect configuration, active-owner presence, database topology and recovery state; the report does not expose credential values.

`npm run package:preview` creates the normal application ZIP and tar archives in `release/`; the command's historical name does not enable disposable mode. `npm run package:synthetic-preview` creates a separate disposable-mode archive. Packaging requires the `zip` and `tar` commands (Linux/WSL/macOS), uses an explicit file allowlist and refuses a filled `.example.env`. Every raw assignment is checked: duplicate keys, a private value followed by a blank duplicate, malformed settings and multiline values are rejected. Keep the distributed template blank and set private deployment inputs at the destination. Packages include source, EJS views, assets, lockfile, unit/native/browser tests, CI configuration and docs; they exclude dependencies, databases, logs, browser binaries and backup storage.

The current hosting account, runtime availability, DNS, provider credentials and deployment persistence were not supplied for this migration; this guide is configuration guidance, not a completed deployment.

No hosting deployment was performed for release 2.5.0. Keep the deployment verification below as a separate step on your configured host.

Use a MongoDB account allowed to read/write this database and create the application's collections/indexes. Configure the database network policy to allow the application host. Run the app from its project directory because `.example.env`, views and bundled PDF/font paths are resolved there.

The supplied Compose service is for local development, runs as a one-node replica set and exposes MongoDB only on localhost. Use an authenticated managed replica set or an appropriately secured production deployment for hosting. Do not point the app at a standalone MongoDB instance.

## Environment inputs

`.example.env` remains the distributed template and can be filled directly on a private deployment; renaming it is unnecessary. If an existing private `.env` file is present, the loader selects that file instead. The two files are not merged: `.example.env` is loaded only when `.env` is absent. Existing host/process environment values take precedence over the selected file, including explicitly empty values. Normal startup, Hostinger startup, deployment checking and synthetic startup use this same selection rule. Restart after changing settings.

Release 2.4.0 adds optional `TRUST_PROXY`, empty by default; see the proxy section below. Readiness, leases and worker limits use code defaults; keep using the existing `.example.env` template and host settings. Reminder timing is an administrator-managed per-business database policy. Recurring schedules are stored and managed in the application. Both features require the persistent Node.js process to be running for background work.

Provision the initial owner with `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME` and `INITIAL_ADMIN_PASSWORD`. Use a password of at least 12 characters. Remove both email/password startup values after the initial login. Public signup alone does not grant administrative access.

Do not place `.example.env`, the project root or backup storage in a public static directory. The supplied server exposes only specific browser asset folders. Publish the blank template with source; keep filled credentials private.

### Reverse proxies and account limits

Leave `TRUST_PROXY` empty when clients connect directly. The app ignores untrusted forwarded client addresses. Behind a reverse proxy, configure a comma-separated allowlist of only the actual proxy IP addresses/CIDRs on the application network. For a proxy on the same host, a reviewed configuration might be `127.0.0.1/32,::1/128`; use this only if those are the real forwarding peers. A hosting platform can use different addresses; check its topology before configuring them.

Do not use `true`, numeric hop counts, wildcard names or all-address ranges. The configuration parser rejects those shortcuts. Both the startup path and `npm run check:deployment` validate the input without printing its values. Preflight validation cannot establish that a syntactically valid address belongs to the actual proxy.

The trusted proxy must remove/overwrite incoming `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` before setting its forwarded headers. Restrict direct access to the backend where the hosting network allows it. These settings follow the [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

Account request counters now live in MongoDB and are shared across processes using the same database. Login allows 20 requests per 15 minutes, signup 10/hour, forgot-password 8/hour and reset-password 15/hour per normalized client address. Expired windows are reset using the database clock, independently of TTL cleanup. An unavailable counter returns a controlled 503 before credential checks; a reached allowance returns 429 and `Retry-After`. Successful account mutations retain their existing transaction and access checks.

Use **My sessions** for own active sign-ins, and **Security activity** / **Team access** for administrator history and selected-account session revocation. Repeated failed attempts are sampled in history, so event counts are not a count of every attempted login. See [Phase 4](PHASE-4.md) for the exact contracts and limits.

## Razorpay and Cashfree

Each business has an explicit gateway setting and server-side credential profile. Open **Business settings** and **Payments & email** to see its selected provider, configuration prefix and webhook path.

| Business/profile                           | Required variables                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared Venturecore Razorpay                | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`                                                                                           |
| Shared Venturecore Cashfree, when selected | `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENVIRONMENT`                                                                                        |
| Independent Shri Sarraf                    | `SHRI_SARRAF_CASHFREE_CLIENT_ID`, `SHRI_SARRAF_CASHFREE_CLIENT_SECRET`, `SHRI_SARRAF_CASHFREE_ENVIRONMENT`                                                    |
| Division-specific account                  | Complete prefixed credential group, for example `PIRENTO_LEGAL_RAZORPAY_KEY_ID`, `PIRENTO_LEGAL_RAZORPAY_KEY_SECRET`, `PIRENTO_LEGAL_RAZORPAY_WEBHOOK_SECRET` |

Keep Cashfree in `sandbox` and Razorpay on test keys until the hosted test flow succeeds. Select `production` for Cashfree only with matching live credentials. A configuration badge confirms that required fields exist; it does not validate an account or settle a payment.

Webhook URLs use the business ID, not its editable display name:

```text
https://billing.example.com/api/webhooks/razorpay/ORGANIZATION_ID
https://billing.example.com/api/webhooks/cashfree/ORGANIZATION_ID
```

For Shri Sarraf the path is `/api/webhooks/cashfree/shri-sarraf`. The original unscoped `/api/webhooks/razorpay` remains available for the shared main account. Use the business-specific path shown in the interface for each merchant configuration.

Cashfree signatures use that account's client secret. Razorpay uses its webhook secret. Send the original raw webhook body through the reverse proxy without rewriting it. Client redirects, screenshots and manually entered receipt references do not mark an online payment verified; the server checks the provider response and amount/currency/business relationships before recording it.

For a division, defining any key in an override group disables shared fallback for that entire group, even if the value is empty. Fill complete groups together. Independent businesses never inherit Venturecore gateway/email credentials. Commented override lines in `.example.env` are deliberately inactive until needed.

## Email and reset links

The preserved email adapter uses **Resend's HTTP API**, not SMTP. Set `RESEND_API_KEY` and a verified `EMAIL_FROM`. A Hostinger business mailbox can be a contact or reply address, but its mailbox password is not a Resend API key.

Shri Sarraf uses its own `SHRI_SARRAF_RESEND_API_KEY`, `SHRI_SARRAF_EMAIL_FROM` and `SHRI_SARRAF_EMAIL_AUTOMATION`. Other organizations can use the documented complete prefixed override group.

Set `EMAIL_AUTOMATION=true` only when automatic invoice/payment/failure notifications should send. The manual Email page still requires a configured sender. Messages save a recipient/payload history, use idempotency keys and expose delivery failures/retry controls. Restored held messages do not automatically resume because credentials or automation settings change.

Password reset email additionally requires a correct `PUBLIC_APP_URL`. Reset links point to the EJS `/reset-password?token=...` page. Without a configured reset sender, the API gives the same generic response and does not reveal whether an account exists or expose a token in the browser.

### Phase 3 reminder and recurring automation

The **Payment reminders** page has its own off-by-default business policy. `EMAIL_AUTOMATION` continues to control the older invoice/payment/failure notifications; it does not enable reminder policies. A configured sender is required for manual and automatic reminders. Each rule is evaluated on the current Indian business date, and missed reminder dates are skipped after downtime. Policy changes hold old unattempted automatic messages.

Recurring schedules generate draft invoices for review. New schedules are paused unless the administrator explicitly activates them. The server processes at most 20 due schedules per pass, one occurrence per schedule, and records a 60-second eligibility delay. Weekly/monthly/quarterly/yearly dates keep their original anchor. Past-due schedules catch up in bounded passes using their scheduled issue dates; review the backlog before resuming. A failed reference puts the schedule into a visible error state until it is repaired and resumed.

The runtime checks both automations at most once per 60 seconds before its email queue processing. All schedulers stop accepting new work during shutdown. They run inside the application process; a host that suspends the process cannot execute a due job until it resumes. No external cron account is configured.

Restore disables reminder policies and pauses unfinished recurring schedules. The global `db:resume` acknowledgement does not re-enable them. Review each business policy and schedule separately as described in [Migration and recovery](MIGRATION.md).

### Worker leases and a coordinated upgrade to 2.5.0

Each new worker claim has a unique ownership token. Renewals and completion writes require that token and an unexpired lease, preventing a worker that lost ownership from overwriting a newer attempt. Claim and lease timing uses the application clock, so keep the clocks of hosts sharing a database synchronized.

| Operation                                         | Default behavior                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Queue polling                                     | Every 15 seconds, with no overlapping queue run in the same worker.                                                |
| Email claim lease                                 | Five minutes.                                                                                                      |
| Lease heartbeat                                   | Every 100 seconds, plus ownership checks before critical steps.                                                    |
| Durable claim/worker writes outside a transaction | Majority write concern with a 10-second operation timeout. Transactional writes retain their transaction settings. |
| Worker drain                                      | 20 seconds for the current delivery before local waiting/HTTP work is aborted.                                     |
| Shutdown claim release                            | A three-second database timeout; only the still-owned claim can be released.                                       |
| Overall HTTP/process shutdown                     | 30 seconds, then forced connection closure and exit code 1 if unfinished.                                          |

**Stop all older application/email-worker processes before starting 2.5.0 workers.** Phase 3 and older writers do not acquire the organization transaction stripes, so mixed versions can violate cross-record coordination. Workers from before Phase 2 also lack claim-token ownership, and Phase 2 workers do not understand reminder eligibility and payload preparation. Phase 7 also requires matching server/browser pricing and directory code. Do not share the outbox between old and new workers. Use this coordinated sequence:

1. Prepare and verify a private backup, arrange the traffic cutover, and send SIGTERM to every old application or separate worker process. Ensure a supervisor does not immediately restart an older copy.
2. Wait for the old processes to exit. Allow the host at least the application's 30-second shutdown window, with a small margin before a platform SIGKILL. Preserve the database and outbox records, including sending claims and saved payloads.
3. Install the 2.5.0 release, run `npm ci`, `npm run build` and `npm run check:deployment` against the intended database and existing private configuration. This upgrade does not require clearing the outbox or replacing the database. Startup creates the required indexes, including the two exact-collation directory indexes, and any required fixed transaction coordination rows. Each new email claim obtains its own token. Every replacement must use the same release/protocol; use a stopped cutover, then refresh existing browser tabs.
4. Start the replacement processes and require a successful `/api/ready` response before restoring traffic. Check startup/shutdown events and the Email page for deliveries that need review. Keep one scheduled backup writer per backup directory.

A process that exits before releasing its claim leaves that row unavailable until its lease expires; the new worker can then claim it. During graceful shutdown, unattempted work can be queued immediately, while interrupted attempted work is queued with a one-minute retry delay if the release succeeds. Database unavailability leaves the lease to expire. Do not clear claim fields or recreate messages to force an earlier retry.

Every retry keeps the same provider key, `venturecore-email/<message ID>`, and an attempted delivery keeps its saved body, attachment, sender profile and original first-attempt time. The application's existing 23-hour safe retry limit still applies. An aborted local HTTP request may already have been accepted by the provider; a fresh key could send a duplicate. Review unconfirmed/held/failed messages through the existing delivery controls and provider records.

### Workspace loading after the upgrade

Document list pages now use server-side search, status and business-product filters and show 50 projected rows per page. Their CSV export includes every matching record, independent of the current page. Overview totals still cover the full applicable financial history; only its recent-document and pending-installment previews are limited. Edit/preview pages fetch the selected full document. These changes are implemented in `src/services/pages/workspace-data.js` and `src/models/workspace-queries.js`; the existing `GET /api/documents` response remains a full authorized array.

Contacts and catalog now also use 50-row server pages. The document editor initially loads 20 contacts and 20 catalog entries, plus any selected historical records, and fetches further results through bounded lookup endpoints. Saved drafts and add-contact returns hydrate referenced IDs explicitly, so a contact outside the first page remains selected. Their CSV endpoints stream every matching record. Simple binary collation preserves exact organization/record IDs and stable name/ID ordering; text search uses escaped, case-insensitive literal regex. These substring searches are bounded in response size but are not claimed to be fully index-covered.

### Verify before preparing a release

Run `npm ci` and `npm run test:browser:install` on the verification machine. Supply `MONGODB_TEST_URI` for a dedicated test replica set, then run `npm run verify:release`. Alternatively install a local `mongod` and run `npm run verify:local`; `MONGOD_BINARY` can point to its executable. The local runner creates its own temporary replica set and removes its own data after verification. Test databases have generated names and must never be run against a live business deployment. A missing database prerequisite or skipped native test fails the release gate. See [Verification](VERIFICATION.md) for exact commands and measured results.

## GST lookup

| Mode                   | Configuration                                                                                                | Behavior                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Public portal          | Leave provider unset, or use `GST_PROVIDER=portal`.                                                          | Human-entered CAPTCHA, short-lived server challenge and fetched registration details.         |
| Sandbox provider       | `GST_PROVIDER=sandbox`, `SANDBOX_ENVIRONMENT=test` or `production`, `SANDBOX_API_KEY`, `SANDBOX_API_SECRET`. | Server obtains a provider token. Test responses are examples, not real customer verification. |
| Generic HTTPS provider | `GST_PROVIDER=generic`, `GST_LOOKUP_URL`, optional `GST_API_KEY`.                                            | Replaces `{gstin}` in the URL and accepts the documented normalized JSON response.            |

The generic provider response is `{ "gstin": "...", "name": "...", "address": "...", "stateCode": "27", "status": "Active" }`, optionally wrapped in `data`. The `status` field is optional. The API key is sent as a Bearer token. Review retrieved data before saving; failures do not generate invented taxpayer details.

## Readiness, logs and shutdown

Configure **unauthenticated** monitoring probes. `/api/health` retains its existing response contract and gives `{ "ok": true }` without a session. Use **`/api/ready`** to decide whether this process can currently serve MongoDB workspace data. Configure the reverse proxy/load balancer to avoid caching probes and allow slightly more than the application's 1.5-second readiness budget for the HTTP request.

```sh
curl --fail --max-time 3 https://billing.example.com/api/ready
```

A healthy response has HTTP 200 and this shape:

```json
{
  "ok": true,
  "ready": true,
  "state": "ready",
  "checks": { "database": "up", "recovery": "clear" }
}
```

| State                             | HTTP response and action                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ready`                           | 200; MongoDB responded and recovery review is clear.                                               |
| `unavailable`                     | 503; MongoDB or the recovery-status read failed/timed out. Check database access and connectivity. |
| `recovery_required`               | 503; follow the existing recovery review procedure before admitting traffic.                       |
| `starting`, `draining`, `stopped` | 503 while the endpoint is reachable; keep traffic off this process.                                |

Non-ready responses include `Retry-After: 5`. The probe checks MongoDB `ping` and recovery status within a 1,500 ms total deadline, coalesces simultaneous checks and does not retain a cached successful result for later requests. A pending recovery marker still blocks normal startup. Readiness does not validate payment/email credentials, send messages, verify a backup or check provider availability.

Collect the process's JSON stdout logs with the host's logging facilities. Useful events include `server_starting`, `server_listening`, `server_start_failed`, `readiness_changed`, `request_failed`, `email_worker_failed`, `automation_failed`, `backup_failed`, `shutdown_started`, `shutdown_completed` and `shutdown_timeout`. Completed and aborted requests are also recorded with their method, registered route template, status and duration. No external logging service is installed by this release.

Every response handled by request diagnostics carries a server-generated `X-Request-ID`; unexpected API server errors include the same `requestId` in their generic JSON error body. Use that ID to correlate a reported failure with the logs. Supplied client IDs, actual URLs/query strings, request headers/bodies, credential values, MongoDB URIs and error messages/stacks/causes are excluded from these logs; only allowlisted error classes and codes are recorded.

Use SIGTERM or SIGINT for an orderly restart. The process immediately becomes unready, stops polling/claiming email and scheduling backups, closes its listener and waits for accepted requests, the active delivery and backup cleanup before closing MongoDB. New business requests that still reach it receive 503 with `SERVICE_DRAINING` and `Retry-After: 5`. A completed normal shutdown exits 0. The 30-second deadline forces exit 1 for stuck work and records `shutdown_timeout`; treat that event as a reason to review the interrupted job. Repeating a stop signal does not start a second shutdown workflow.

## Backup storage and cutover

Set `DATABASE_BACKUP_DIR` to a private persistent directory outside public assets. Set `BACKUP_ENABLED=true`, `BACKUP_INTERVAL_MINUTES` and `BACKUP_RETENTION_COUNT` for scheduled snapshots. The default schedule is one snapshot per day with seven retained. Keep one scheduled backup writer per directory. Copy verified backups off the application host according to your operational needs.

The app must have permission to create private backup directories/files. The backup permission checks target POSIX filesystems. Use Linux or WSL for the backup/import tooling if running on a platform that cannot enforce those permissions. The EJSON data and manifest form one recovery set. [Migration and recovery](MIGRATION.md) explains restore and reconciliation.

The Backups page, backup inventory API and scheduler initialization use `listBackupMetadata()` to read manifests and filesystem metadata quickly. Inventory rows report `verified: false` and `verification: "on_download"`; this means the snapshot contents have not been reverified during that listing. Private paths, expected files, manifest fields and recorded file size are still checked. Opening the inventory does not wait behind an active snapshot operation or hash every stored database file.

Creating a backup, downloading its data or manifest, explicit verification and restore still perform full validation, including the snapshot content and checksum. Retention also retains its verification checks. Use `npm run db:backup -- --verify=SNAPSHOT_ID` when you need an explicit verification result, and keep both the EJSON data and manifest when copying a backup off-host. A fast inventory entry alone does not establish that a backup is ready to restore.

Before accepting real users, verify HTTPS login and logout, persistent MongoDB data after a restart, approved staff scope, a private backup download, PDF output, a provider test payment/webhook and a test email from the correct business. Those hosted/provider checks require your own configuration and were not performed with live accounts here.
