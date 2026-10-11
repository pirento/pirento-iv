# Verification

## Current Phase 7 release 2.5.0 — executed results

Verified on **11 October 2026** with Node **24.19.0**, a fresh local MongoDB **7.0.14 replica set**, Playwright **1.64.0** and Chromium headless shell **136.0.7103.25**. All runs used synthetic records and controlled provider transports. The complete `verify:release` sequence passed; after the final command-interruption cleanup refinement, the source and full unit gates were rerun successfully. The current totals are:

| Gate                                  | Executed result                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Source and EJS build check            | **219** JavaScript modules/EJS templates checked or compiled.                               |
| Database-independent tests            | **90 passed**, 0 failed, 0 skipped.                                                         |
| Native MongoDB integration            | **121 passed**, 0 failed, 0 skipped, including every earlier suite and the new regressions. |
| Maintained Chromium browser workflows | **9 passed**, 0 failed, 0 skipped, no retries and no uncaught page errors.                  |
| Readiness audit                       | 9 runtime dependencies checked, **no findings**.                                            |

Node counts include parent tests and subtests. The nine Playwright tests are the maintained Phase 7 suite included in this archive; earlier historical browser counts below are not presented as newly rerun checks. See [the machine-readable release record](PHASE-7-VERIFICATION.json) and [Phase 7 behavior/upgrade notes](PHASE-7.md).

### New and retained coverage

| Area                             | Evidence from the current tests                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact decimal money              | Both fractional-product examples give ₹10.08; exponent inputs, exact/below-half ties, recurring periods, jewellery charges, discounts and mixed GST stages are covered. Native checks compare persisted totals, EJS, PDF definitions and queued email payloads.                                                                                            |
| Historical compatibility         | Old unmarked ₹10.07 amounts remain unchanged through notes-only edits, issuing, preview/email/PDF and conversion. The real browser verifies unchanged legacy lines/totals after editing notes, followed by decimal repricing after an allowed financial draft edit. Recurring drafts use the new policy without changing the source.                       |
| Save and navigation reliability  | Real contact/catalog saves and logout succeed with throwing browser storage; password reset uses a captured transport and accepts the replacement password. Lost committed invoice responses retry to one document/request record. Stale tabs retain unsaved input and cannot overwrite newer data.                                                        |
| Complete financial flow          | The browser creates a ₹10.08 invoice, confirms MongoDB and preview, downloads a valid PDF, records ₹5.00 and observes a ₹5.08 balance in UI and database. The PDF download check validates file structure; native PDF-definition checks validate amounts.                                                                                                  |
| Directory scale and completeness | A native fixture with 131 contacts and 131 catalog records yields 50-row pages and an editor with 20 initial records from each directory: **35,621 bytes** of page data. Browser fixtures cover 121-record pages, full CSV and result 121 in editor search. A new contact beyond the first lookup page returns to its exact draft.                         |
| Identity and query boundaries    | Native tests verify exact tenant/record identity for case and numeric aliases, organization permissions, archived selections, escaped search, input validation and the retained full-array API. Basic sorted page plans avoid collection scans/blocking sorts and examine at most 50 documents. Substring search is not claimed to be fully index-covered. |
| Startup and release guards       | Actual Hostinger loading-order regressions cover private/example/host precedence. Real normal-production startup refuses an unintended empty database before creating collections. Raw duplicate/private template values are rejected, including a private assignment followed by a blank duplicate.                                                       |
| Verification cleanup             | Rejected initialization still removes its own seeded test database. Cleanup continues after simulated shutdown errors while preserving an unrelated sentinel database. Actual subprocess regressions verify termination of both a stubborn descendant and a command leader that ignores SIGTERM.                                                           |
| Retained application             | Native suites rerun accounts, sessions/security activity, financial transactions, installments, receipts/providers, document revisions/idempotency, worker leases/drain, recurring/reminder automation and backup/import/recovery.                                                                                                                         |

The mobile menu check uses a 390-pixel viewport and verifies open/close, keyboard focus wrapping, Escape, focus return and absence of page-level horizontal overflow. Browser page-error capture observes every page in the context, including the second editor tab.

These runs establish the covered behavior on the listed local runtimes. They do not certify live payment/email/GST accounts, Hostinger deployment, production capacity, remote CI execution or an unprovided business database. The included GitHub Actions workflow and setup guides make those next environment checks reproducible. The original Phase 5–6 audit JSON and checkpoint files remain historical; their earlier Node 22/missing-dependency findings do not describe this verification.

## Earlier Phase 4 release 2.4.0 — recorded results

The complete release passed **53 database-independent tests** and **116 native MongoDB integration tests**, with **zero failures and zero skips**. The native run used a disposable MongoDB 8.2.1 replica set and reran every earlier integration suite together with the new shared authentication, session/activity, transaction-scope, reminder-candidate and financial regressions. Counts are the Node test runner's reported totals, including parent tests and subtests. The source gate checked/compiled **193 JavaScript modules and EJS templates**. Prettier formatting verification passed.

Authenticated Chromium passed **51 grouped browser checks** against the real Express/EJS application: 11 new session/security groups and all 40 retained Phase 1–3 groups. Every harness reported **zero uncaught page errors**. The new security harness and the retained harnesses that track server responses also reported zero 5xx responses. Each harness used its own disposable database/application and invented test records; provider transport was mocked.

| Phase 4 check                     | Verified behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared authentication limits      | Two independent application clients share atomic request allowances. Concurrent first use, window expiry without TTL cleanup, application-clock skew, normalized IPv4/mapped addresses, untrusted forwarded headers and explicitly trusted proxy chains are covered. Unavailable counters return controlled 503 responses before password/account work; failed passwords and counters avoid financial locks. Observation failures retain the intended generic response.                                              |
| Sessions and security history     | Own-session pagination and current identification; independent public session IDs; normal and unsupported legacy IDs; individual, other-session and administrator revocations; fresh acting-session/access checks; safe replay; administrator-only history; inclusive IST filters; actor/affected-account filters; deterministic pagination and allowlisted legacy event details. Cookie tokens and stored token hashes are not exposed.                                                                             |
| Session/security browser controls | A 53-session fixture paginates 50/3. Cancel performs no mutation. A lost committed revocation response can be retried safely. Sign out others preserves the current session. Current-session and administrator self-revocation redirect to login. Staff can manage their sessions but cannot open security history. Team revocation preserves role/status/assignments; hostile identity text is escaped. A 53-event fixture verifies date/account/action filters and pagination.                                     |
| Business transaction scopes       | Controlled gates verify real overlap for different stripes, serialization for the same stripe and colliding organizations, global exclusion in both directions, nested inheritance/rejection, rollback and fail-closed missing locks. Customer creation/deletion, format updates, payment/void and payment-link reservations retain their atomic boundaries. Provider HTTP remains outside retryable transactions. Import/restore accepts only exact fresh destination coordination rows and skips source lock rows. |
| Legacy receipt authorization      | Real signup, approval and staff login verify correction of own-business receipts whose organization is missing/null. Foreign businesses, explicit receipt/parent mismatches and a parent changed after middleware authorization remain denied. Malformed parent identifiers fail before a parent lookup. Receipt replay and the existing gateway correction restriction are retained.                                                                                                                                |
| Consistent payment/ledger money   | A historical ₹0.125 receipt counts as 13 paise throughout. On a ₹1 invoice, another ₹0.88 is rejected without a mutation; the correct ₹0.87 settles exactly. Payment replay, both receipt corrections and correction replay preserve balances and complete ledger history. Invalid/unsafe active amounts and unsafe sums block new payments; incorrect numeric receipts can still be voided. Large safe odd paise values and a one-paise overdue remainder agree across the status helper, page and export.          |
| Ledger reads                      | Half-paise and large-value native aggregation parity, invalid legacy amount/history handling and a single actual receipt-history read per statement are covered. Concurrent read-only snapshots keep list/history consistent and do not increment any of the 33 coordination rows.                                                                                                                                                                                                                                   |
| Reminder candidate queries        | A fixture with 1,211 open invoices returns 10 candidates while examining 10 documents and 12 index keys. Both due-date indexes participate, with no collection scan. Seven reminders queue; a repeated pass creates zero and recognizes seven existing events. Full dashboard totals still include all 1,210 eligible targets. Indian-midnight rollover and current eligibility/deduplication checks remain covered.                                                                                                 |
| Retained workflows                | Every earlier native suite passed, including document/version/request identity, installments, payments/providers, worker claims/drain, actual background automation, snapshots/import/recovery, synthetic preview and deployment checks. Existing browser draft/contact recovery, lost-save behavior, manual receipts, document pagination/CSV/actions, ledger/statement/print, reminder preview/delivery and recurring schedules also passed.                                                                       |

The new sessions, activity, team and confirmation layouts were checked at **390 pixels**, including keyboard dismissal, focus and no page-level horizontal overflow. Earlier mobile navigation, draft controls, statement and recurring workflows were rerun in their retained browser suites. A table may scroll within its own container without overflowing the page.

The final ZIP is checked for valid archive integrity, exact source allowlist/file-byte agreement, consistent **2.4.0** package/lockfile versions and blank distributed credential inputs. All paths from the preserved Phase 3 source ZIP remain present, and new Phase 4 code, EJS views, assets, maintained tests and guides are included. Runtime databases, backups, logs, dependencies, `.env`, TypeScript and JSX are excluded. The maintained unit/native tests are included; local browser harnesses and downloaded test binaries remain verification tools outside the application package.

These results establish the covered behavior with native database transactions and controlled transports. They do not measure production throughput, reconstruct missing historical transactions or validate real provider accounts. No live email/payment, hosting deployment or production database cutover was performed. The [Phase 4 guide](PHASE-4.md) records the remaining environment setup and the mandatory stopped-process upgrade: older writers must be stopped before the new coordination protocol starts.

## Earlier Phase 3 release 2.3.0 — final results

The complete release passed **47 database-independent tests** and **78 native MongoDB integration tests**, with **zero failures and zero skips**. The native run used a disposable MongoDB 8.2.1 replica set and included every earlier integration suite plus the new ledger, reminder, recurring and actual-runtime tests. Counts are the Node test runner's reported totals, including parent tests and subtests. The source gate checked/compiled **178 JavaScript modules and EJS templates**. Prettier formatting verification passed.

Authenticated Chromium passed **40 grouped browser checks** against the real Express/EJS application: eight new ledger/reminder groups, eight new recurring groups, and all 24 retained Phase 1/2 groups. All five harnesses reported **zero uncaught page errors**. The new receivables and retained document-list harnesses additionally tracked server responses and reported zero 5xx responses. Each harness used disposable invented records and its own local database/application; email deliveries were mocked.

| Phase 3 check                    | Verified behavior                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger calculations and identity | Partial/full receipts, reasoned voids, cancellation, whole-paise totals, legacy paid fallbacks, valid pre-invoice credit balances, missing/invalid dates, archived contacts, same-name/different-ID contacts, missing-contact snapshots and separate unlinked invoices.                                                                                                       |
| Ledger consistency and access    | Real concurrent writes during read-only snapshot sessions, no increment of the shared write lock, organization/customer/staff restrictions, literal filters, complete 105-customer/71-invoice native exports and bounded visible pages. Dedicated ledger native tests also passed with the host timezone set to America/Los_Angeles.                                          |
| Statement browser and print      | 58 matching accounts paginate as 50/8; 62 invoices, two receipts and one void produce 65 statement entries. Date filters keep opening/closing balances separate from current totals. Complete CSV and a five-page A4 print include all entries, and incomplete history shows unavailable balances. Export/print respects unsent filter edits.                                 |
| Reminder correctness             | Invoice/installment allocation, missing recipients, current balance/PDF, Indian midnight, manual/rule deduplication, stale due dates, policy revisions, two independent clients, payment and policy changes during PDF/first transport, frozen uncertain retries, stale claims, stop/drain and paginated history.                                                             |
| Reminder browser                 | 62 eligible targets paginate as 50/12. Preview/cancel creates no message; confirm queues a reminder and repeated confirmation returns the same record. Mocked delivery appears in history. Timing opt-in saves/reloads, missing-email targets explain why they are unavailable, and a payment after preview prevents queueing at confirmation.                                |
| Recurring dates and writes       | Weekly/monthly/quarterly/yearly anchors, short months/leap years, end/count limits, financial-year numbering, frozen commercial inputs with current identity validation, clean drafts from paid/finalized sources, concurrent instances, replay after draft deletion, failed transaction rollback, lost commit recovery, bounded backlog/cooldown and revision/access guards. |
| Recurring browser                | Source selection, paused creation, month-end preview, explicit generation and invoice links, stale two-tab settings with preserved entries, pause/error/repair/resume, one saved schedule after a lost committed response and reload, blocked browser storage, staff read-only access and 390px confirmation controls.                                                        |
| Actual background runtime        | Without directly calling either service's scheduler or queue method, the real HTTP runtime's startup pass creates one recurring draft and starts one exact-day automatic reminder with an actual PDF and mocked transport. Shutdown during that transport preserves the sent result, drains work, then closes its MongoDB client.                                             |
| Backup/recovery                  | Real snapshot/restore disables reminder policies and advances revisions, pauses unfinished schedules while preserving dates/counts, retains completed schedules/occurrences/events, clears email claims and keeps global recovery acknowledgement separate from business automation activation.                                                                               |
| Retained behavior                | Every earlier native business/provider/worker/operations/import/preview suite passed. Existing browser draft/contact recovery, stale edits, lost-save idempotency, receipt validation, 133-invoice pagination, all-record/filtered CSV, action links and mobile drawer checks also passed unchanged.                                                                          |

New and existing mobile layouts were checked at **390 pixels**. The complete statement PDF was rendered and visually inspected; print navigation artifacts were removed and the page background corrected. The statement's first and last invoice, receipt/void rows and current balance footer were verified in the printed output. The PDF used invented acceptance-test data and is not a customer report supplied with this source release.

The final ZIP is checked for a valid archive, exact agreement with the source allowlist and file bytes, consistent **2.3.0** package/lockfile versions, blank credential inputs and inclusion of the Phase 3 code, views, tests and guides. Runtime databases, backups, logs, dependencies, `.env`, TypeScript and JSX are excluded. The maintained unit/native tests are included; local browser harnesses and downloaded test binaries remain verification tools outside the application package.

No live email, payment, production database migration or hosting deployment was performed. These checks establish the covered behavior with native database transactions and controlled transport; they do not establish production throughput or reconstruct missing historical data. See [Phase 3](PHASE-3.md) for the exact workflow and its limits, and the commands below to run the included checks.

## Earlier Phase 2 release 2.2.0 — final results

The combined Phase 2 release run passed **28 database-independent tests** and **47 native MongoDB integration tests**, with **zero failures and zero skips**. These are the Node test runner's reported test counts, including parent tests and their subtests. Every earlier native integration suite was included in this run. The source gate checked/compiled **150 JavaScript modules and EJS templates** and rejected leftover TypeScript/JSX source. Prettier formatting verification passed.

Authenticated Chromium verification passed **24 grouped browser checks**: nine new mobile/draft groups, seven new document-list groups and eight rerun Phase 1 contact/recovery/manual-receipt groups. These runs used the actual Express/EJS application and disposable MongoDB and observed **zero uncaught page errors**. The new list run also observed zero server 5xx responses. The three older Phase 1 installment browser groups remain historical evidence; the native installment-concurrency regressions were rerun in the combined integration suite.

| Phase 2 check                    | Coverage                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page-specific MongoDB queries    | A 151-invoice fixture checks 50-row pagination, no overlap, last-page clamping, complete search/status/product filters, literal regex characters, validation, organization restrictions, selected-document loading and the unchanged full-array API. Normal page loads do not inspect backup inventory.      |
| Financial parity                 | Overview counts, received/outstanding values, six-month totals and top pending rows match the shared calculations, including legacy paid-status fallbacks and unsorted 70/20/10 installment entries. Overdue MongoDB predicates match the shared displayed status.                                           |
| CSV and real list browser        | A 133-invoice browser fixture checks 50/50/33 pages, all-record and filtered CSV from page 2, unsent search text, empty/header-only exports, action links and mobile controls. View/Edit/Payments/Email/Delete links were followed; this check did not delete records or send mail.                          |
| Backup metadata and integrity    | Metadata inventory returns `verified: false` without reading complete contents. Same-size snapshot tampering still causes manifest/download checksum rejection; restored original bytes verify and download correctly.                                                                                       |
| Email leases and fencing         | Two workers, heartbeats through slow PDF/HTTP operations, lease loss, stale successes/failures and delayed writes, legacy claims, missing-token rejection, graceful/forced stop, frozen-request recovery and retryable provider-conflict classification. Phase 1 cancellation and provider suites also pass. |
| Readiness and diagnostics        | Live MongoDB/recovery checks, bounded concurrent probes, lifecycle transitions, request correlation, validation/server-error redaction, safe EJS support references and rejection of new work while draining. Logger failure cannot change responses.                                                        |
| Shutdown                         | An accepted HTTP request and active email both finish before MongoDB closes; the next message remains queued. The actual `server.js` handles SIGTERM with one start/completion event pair, exit code 0 and no stderr. A separate unit test verifies forced shutdown at its deadline.                         |
| Mobile drawer and draft controls | Close/Escape/outside click, keyboard focus, inert background, scroll/focus restoration, viewport reset, confirmed/cancelled Start fresh, existing-document discard, protected unknown creations and contact-handoff invalidation.                                                                            |
| Retained business regressions    | All earlier native backup/restore/import, hosting preflight, document revision/idempotency, financial lifecycle, installments, receipts, gateway, email cancellation and disposable-preview suites were rerun.                                                                                               |

### Controlled measurements

With **151 synthetic invoices**, each carrying 16 KB of private notes, serialized workspace data for the full internal loader was **2,809,893 bytes**. The document-list page data was **33,743 bytes**, approximately **98.8% fewer bytes** for this fixture. This measures page-data size, not HTML compression, end-to-end latency or production throughput. The first-page query's explain output examined **50 documents for 50 returned records** using an index, with no collection scan or blocking sort in its winning plan.

A separate native experiment stopped the actual disposable MongoDB server. Readiness changed from HTTP 200 to **503 in 1,505 ms** while the unauthenticated liveness endpoint remained HTTP 200. This checks the configured 1,500 ms probe deadline under database loss; it is not a hosting availability measurement.

The final archive is checked for source-byte parity, valid ZIP contents, matching 2.2.0 package/lockfile versions, blank distributed credentials and exclusion of runtime data, dependencies, `.env`, TypeScript and JSX. Browser automation harnesses and downloaded test binaries are scratch verification tools, not application dependencies; the maintained unit/native regression tests are included in the source archive.

See [Phase 2](PHASE-2.md) for the user-facing changes, API details, coordinated worker upgrade and remaining scaling limits.

## Earlier Phase 1 release 2.1.0 — final results

The combined Phase 1 run passed **19 database-independent tests** and **26 native MongoDB integration tests**, with **zero failures and zero skips**. The 26 native results are the test runner's reported tests, including the email suite's parent test and its subtests. All earlier database integration suites were rerun as part of this combined run. The source gate compiled/checked **139 JavaScript modules and EJS templates**. Prettier formatting verification passed.

Phase 1 browser verification passed **11 grouped checks** against the real authenticated Express/EJS application and disposable MongoDB: seven document/contact/recovery groups, one manual-receipt group and three installment-concurrency groups. These runs observed **zero uncaught browser page errors**. The broader migration browser runs described below are earlier baseline evidence; they were not all repeated for Phase 1.

| Phase 1 check                        | Coverage                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor state and native browser      | Standalone contact creation cannot change another draft; intended contact return is scoped and single-use; unsaved entries survive conflicts; confirmed validation rejection remains editable.                                                                   |
| Creation request persistence         | A successful POST response is deliberately lost, followed by page reload and retry; exactly one invoice is created. Conflicting reuse links to the existing document, and blocked session storage sends no creation request.                                     |
| Native MongoDB document writes       | Creation replay across server instances, one number/email, failed transaction rollback, request conflicts, deleted drafts, stale edits, legacy revisions, receipt-driven revisions and stale installment replacement/removal.                                    |
| Receipt validation and gateway dates | Whole-paise/minimum validation, Indian calendar boundaries, historical receipt retries, trusted provider timestamps and both gateway paths. The real browser rejects future/sub-paise receipts and saves INR 0.01 against an INR 100 invoice, leaving INR 99.99. |
| Email cancellation                   | Queued and claimed unattempted messages, cancellation during PDF preparation, preparation failures, transactional cancellation/hold, first-transport boundary, identical uncertain retries and password reset preservation.                                      |
| Installment browser concurrency      | Two-tab stale plan replacement, a history refresh during editing and stale plan removal. Conflicts keep entered rows visible; applying changes against the reviewed latest plan succeeds.                                                                        |

The dedicated payment integration suite also passed with the server process in `America/Los_Angeles`, verifying that the Indian business-date rules do not depend on the host timezone. An independent transaction-retry check injected a transient MongoDB transaction error after a successful document compare-and-save; the retried operation incremented the revision only once.

See [Phase 1](PHASE-1.md) for the precise API compatibility changes, browser recovery behavior and email delivery boundary.

## Earlier migration verification

Before Phase 1, the migration's combined run passed **10 database-independent tests** and **8 native MongoDB integration tests**, with zero failures and zero skips. Those integrations included 30 grouped backend lifecycle/provider scenarios plus database tools, hosted preflight and disposable preview checks. The source gate then checked 130 JavaScript modules and EJS templates.

The migration's authenticated browser rerun passed all 13 core behavior groups, including the formatted EJS views and corrected mobile widths. Independent document and management browser runs also passed. The source parity audit found all **58 original normal application endpoints** present; the separate original synthetic-preview endpoints and launch mode were restored as well.

### Migration coverage

The migration was checked with an actual MongoDB 8.2 replica set and headless Chromium. Browser checks used the real Express/EJS application and authenticated HTTP/API requests. Each run used isolated invented test data; no external customer database was available.

| Check                          | Coverage                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript/EJS source gate     | Syntax of all JavaScript files, compile of every EJS template and rejection of TypeScript/JSX source files.                                                                                     |
| Four EJS rendering tests       | All document kinds, all five preview layouts, saved snapshots, escaping and initial payment/email controls.                                                                                     |
| Deployment/package checks      | Blank-template packaging, filled-credential rejection, first-launch/existing-database distinction, recovery holds and read-only MongoDB inspection.                                             |
| Database tooling suite         | Native BSON/index preservation, checksum rejection, occupied-target refusal, rollback, all 25 SQLite tables, schema/integrity checks, immutable source, sessions and email recovery.            |
| Native MongoDB lifecycle suite | Organization scope, numbering, concurrent saves, snapshot preservation, issued/final locks, receipts, overpayments, voids, installments, conversions, backup and recovery.                      |
| Provider/outbox suite          | Razorpay and Cashfree verification, signed/deduplicated callbacks, two-server concurrent callback/link creation, provider isolation, email and GST adapter behavior.                            |
| Core browser run               | Four auth pages, login/logout, sixteen workspace screens, nine new-record screens, real contact save/archive/restore, organization/branding settings, CSV download and mobile navigation.       |
| Document browser run           | Recurring invoice totaling INR 354,000 including tax, real PDF download, lock behavior, 70/20/10 schedule, partial/full receipt, finalization, reasoned void, challan and quotation conversion. |
| Management browser run         | Catalog pricing/archive/duplicate/search/CSV, business products, format controls/presets, team signup/approval/disable, backup downloads, integration status and mobile layouts.                |

Six real CLI commands—SQLite import, resume, backup, verify, restore and resume—also passed using a schema-v5 database created by the original application. The round trip retained its 6 organizations, 90 formats and 10 products.

The optional preview also passed three configuration/transport tests and a native integration run covering its real EJS notices, login, isolated records, provider blocking and clean shutdown. These automated checks were also rerun in the Phase 1 totals above.

The browser runs observed no uncaught JavaScript errors on the tested paths. Desktop previews and mobile layouts were visually inspected. Responsive table overflow found on the dashboard was corrected and rechecked before packaging.

Provider suites use injected HTTP responses and signed test webhook payloads while exercising real MongoDB transactions. They do not transfer money, send real email or verify a real GST registration. The real PDF check downloaded a valid PDF file from the migrated browser flow.

## Run the included checks

```bash
npm ci
npm run check
npm test
npm run format:check
```

`npm run build` is an alias of the source/EJS check; EJS pages and browser JavaScript do not require transpilation or a frontend bundler.

For native database integration checks, start a disposable MongoDB replica set and provide `MONGODB_TEST_URI` in the command environment:

```bash
# POSIX shell example; use a dedicated local test server or test cluster.
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run test:integration
```

PowerShell equivalent:

```powershell
$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0'
npm run test:integration
Remove-Item Env:MONGODB_TEST_URI
```

As of Phase 7, the required `npm run test:integration` command fails without `MONGODB_TEST_URI`; it also fails if no tests execute or any native tests skip. `npm run test:integration:optional` is the explicit developer convenience command that allows missing setup while reporting that tests did not run. These tests use the supplied URI only for its server, allocate random test database names, and drop only the databases they allocated during cleanup, including partially initialized test databases after setup failure. The test account therefore needs permissions to create/drop those test databases. Do not use production credentials or a production URI.

Unit/native tests use Node's built-in test runner. Phase 7 includes maintained Playwright Chromium tests in `tests/browser/` and `playwright.config.js`, with Playwright pinned as a development dependency. Normal `npm ci` does not download MongoDB or browser binaries. Install the browser separately and run the complete gate against a dedicated test replica set:

```bash
npm run test:browser:install
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run verify:release
```

With an installed local `mongod`, `npm run verify:local` creates a new temporary replica set, runs that same gate and removes its own data afterward. `MONGOD_BINARY` selects a specific executable. An existing browser executable can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; otherwise Playwright uses its installed Chromium. On Linux, `npx playwright install --with-deps chromium` installs the browser and required system packages where permitted.

The GitHub Actions workflow at `.github/workflows/verify.yml` installs Node 24, runs `npm ci`, installs Chromium, starts the supplied Compose test replica set and runs `verify:release`. Browser artifacts are retained only on failure, and the workflow removes its containers/data afterward. This workflow is delivered as source; no remote CI run is claimed. Downloaded binaries, runtime databases, reports and screenshots are excluded from the application ZIP.

## Practical limits

- No deployment to the user's hosting account was requested or performed. HTTPS routing, host runtime support, persistence, backup permissions and email domain verification need a check on the actual host.
- No live business SQLite database was supplied. The importer is for the original schema-v5 database and uses an empty target plus a recovery hold; it does not claim an unprovided database was already imported.
- Live Razorpay/Cashfree, Resend and GST provider accounts were not configured. Their transport behavior was tested with controlled responses, but actual account activation, payouts, sender delivery and live taxpayer responses remain environment-dependent.
- Automated checks cover the preserved high-value workflows and concrete migration risks. They do not constitute an exhaustive proof for every possible user input, provider response or production workload.
