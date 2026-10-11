# Phase 7 — release 2.5.0

Phase 7 implements the next reliability phase identified in the review of the supplied Phase 5–6 archive. This is a complete source release of the existing EJS, browser JavaScript, Express MVC/service-layer and native MongoDB application. Earlier account, document, payment, ledger, reminder, recurring, backup and recovery features remain included.

The work covers four confirmed defects, server-paged contact/catalog workflows, maintained browser/database verification and consistent release instructions. The original Phase 5–6 status and implementation files are retained as historical checkpoints. Current executed results are in [Verification](VERIFICATION.md).

## 1. Decimal financial calculations

The former calculation rounded an already imprecise binary multiplication. Values such as `0.5 × 20.15` and `1.25 × 8.06` could both become ₹10.07 even though their exact decimal product is 10.075.

New financial work uses exact decimal arithmetic internally and explicit half-up rounding at the existing business stages. Both examples now produce **₹10.08**. The same arithmetic covers standard and recurring line amounts, jewellery net weight and charges, invoice discount, taxable amounts and GST splits. For example, 18% of ₹13.25 rounds to ₹2.39. No new external calculation dependency or browser bundler is required; `shared/decimal.js` uses native `BigInt` internally and returns the application's existing numeric values at its boundary.

Newly calculated totals include:

```json
{
  "roundingPolicy": "decimal-half-up-v1"
}
```

The server remains authoritative. A caller cannot override saved totals by posting its own `totals` object. Existing whole-paise receipt validation, overpayment checks, financial locks and revision/request identity rules still apply.

### Saved document compatibility

| Document action                                            | Financial behavior                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| View, print, PDF or email an older unmarked document       | Use the saved historical calculation policy; no silent repricing.             |
| Edit notes/title or issue an otherwise unchanged old draft | Preserve its saved totals and unmarked legacy policy.                         |
| Change allowed financial inputs on an editable draft       | Recalculate with the decimal policy and save the new marker.                  |
| Edit an issued document or invoice with receipts           | Retain existing financial locks; the rounding fix does not bypass them.       |
| Convert an existing quotation/proforma                     | Preserve the agreed commercial totals carried by conversion.                  |
| Generate a new recurring draft from an old source          | Calculate the new draft using the decimal policy; retain the source document. |

There is **no automatic historical backfill**. For an older document whose saved total is ₹10.07, its line, preview and PDF continue to show the matching historical value until an allowed financial draft edit occurs. Browser editor updates select the document's policy as well as the initial EJS render.

## 2. Successful actions and optional browser storage

Toast messages and convenience cleanup use guarded optional storage helpers. A browser that blocks session storage or runs out of storage space can still complete a successful contact/catalog save, ordinary management save, password reset redirect or logout. Failure to store a notification no longer changes the outcome already confirmed by the server.

This distinction matters for invoice recovery: the persisted draft identity, pending save request and contact-return token are required to prevent duplicate or misdirected work. Those critical paths retain their protective errors when reliable recovery cannot be established. Unknown creation results still use **Retry save**, and stale document revisions retain unsaved input for review.

## 3. One environment selection and production preflight

Every entry point uses this precedence:

1. Existing host/process environment values win, including values explicitly set to empty.
2. If a private `.env` exists, load it as the selected file.
3. Otherwise load `.example.env` directly.

The two files are not merged. A private `.env` replaces the file source; it does not inherit missing keys from `.example.env`. Existing direct-template deployments remain supported, and there is no requirement to create or rename a file. Normal startup, Hostinger startup, deployment checking and synthetic startup use the same loader.

With `NODE_ENV=production`, ordinary `server.js` startup now applies the same read-only preflight used by hosted startup, before collections/indexes or seed records are created. It checks supported Node version, trusted-proxy syntax, exact HTTPS public origin, database topology, intended existing workspace, recovery hold and active administrator or valid bootstrap credentials.

`PUBLIC_APP_URL` must be an origin such as `https://billing.example.com`. Paths, credentials, query strings, fragments and even a trailing slash are rejected. For an intentional first deployment only, set `IV_ALLOW_NEW_DATABASE=true` and valid initial administrator credentials; disable that opt-in after successful first startup. This prevents an accidental database-name change from silently creating another empty workspace.

The disposable synthetic entry remains separate and retains its dedicated database URI, isolation and destructive-operation guards. The production changes do not enable synthetic mode automatically.

## 4. Archive and readiness credential checks

The readiness audit and package builder inspect raw template assignments instead of relying on the final parsed value. They reject duplicate keys even when both values are blank. A populated secret followed by a later blank assignment is therefore rejected before packaging. Filled non-template values, malformed settings and unsupported multiline values are also rejected. Error messages do not echo credential values.

The package builder checks the staged copy again. It includes only approved source roots, rejects symlinks/private nested configuration, and excludes dependencies, `.git`, databases, backups, logs and local test reports. `.github/workflows/verify.yml`, `playwright.config.js` and maintained browser tests are now included. The normal package still starts the persistent application; use the explicit synthetic package command only for a disposable preview.

## 5. Contact and catalog directories

### Workspace pages

Contact and catalog list pages query MongoDB for **50 rows per page**. Search and filters apply to the complete authorized matching set before paging. The matching-result count and page links reflect the requested filters; summary cards retain organization-wide counts. A changed filter returns to the first page. Add/edit/archive/restore workflows remain available.

Contact filters cover role and archived records. Catalog filters cover product/service, archived records, and the selected business product/shared offerings. Queries escape literal search strings before creating case-insensitive regex patterns. Request objects cannot become database query operators. Search strings are limited to 200 characters, and page/filter/identifier inputs are validated.

The new indexes have keys `{ organizationId: 1, name: 1, id: 1 }` and names `customers_directory_name_v1` / `catalog_directory_name_v1`. Both queries and indexes use simple binary collation. This preserves exact organization and record identity, including IDs differing only by letter case or leading zeroes. Name/ID ordering is stable; explicit text search remains case-insensitive.

Unfiltered sorted page plans are verified against the indexes. Substring search can still examine many records in a large organization; bounded response size is not a claim of constant-time search or production throughput. Very deep offset pages and large exports should be assessed against a real workload before further search/index design.

### Editor lookups and complete exports

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

## 6. Included verification workflow

The source includes Node unit/native tests plus a standard Playwright Chromium suite. Browser fixtures start the real authenticated Express/EJS server, use a dedicated MongoDB replica set, allocate uniquely named test databases, and remove their own data. Password-reset transport is captured locally; GST/email/payment transports are controlled. These checks do not send real mail or transfer money.

The browser suite covers login and mobile keyboard focus, saves/logout under blocked optional storage, password reset, decimal and legacy editor amounts, invoice preview/PDF download, a receipt balance, stale tabs, lost successful responses, directory paging/search/CSV and contact-return draft hydration. The native suite also exercises existing financial transactions, providers with controlled responses, account/security flows, leases, recurring/reminder automation and backup/import/recovery behavior.

### Run against an existing dedicated test replica set

```bash
npm ci
npm run test:browser:install
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run verify:release
```

On Linux, Playwright may require system dependencies; its documented installation option is `npx playwright install --with-deps chromium`. If a suitable Chromium executable is already installed, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point to it. Neither browser binaries nor MongoDB binaries are embedded in the application ZIP.

### Run with a temporary local replica set

```bash
# Requires an installed mongod and Chromium prepared above.
npm run verify:local

# Or select a specific mongod executable.
MONGOD_BINARY='/absolute/path/to/mongod' npm run verify:local
```

The launcher allocates a free loopback port, creates a temporary replica set, passes its URI to the requested command, then stops its processes and removes its own data. On POSIX it owns a separate process group for the verification command so interruption also cleans up command descendants. Windows uses direct-child process cleanup. Do not run integration tests with a production URI or production credentials; test users need permission to create/drop their uniquely named test databases.

`npm run test:integration` now fails if the URI is absent, if no tests execute or if any test is skipped. `npm run test:integration:optional` is the explicit local convenience command for a machine without a test database and clearly reports that no database tests ran. The release gate uses the strict command.

The included GitHub Actions workflow installs Node/dependencies/Chromium, starts the supplied MongoDB Compose replica set, runs `verify:release`, retains failure diagnostics briefly and removes its test container/data. The workflow is delivered as source; no remote GitHub Actions run or deployment was performed as part of this build.

## Upgrade and deployment

1. Make and verify a private backup of the intended existing database. Preserve private environment settings separately from the distributed blank template.
2. Stop older application and worker processes. Replace the full source and browser assets with this release, retaining the intended database and private settings.
3. Use Node 24.5 or newer, below 27. Run `npm ci` and `npm run build`. Production can omit dev dependencies after verification.
4. Set the target environment and run `npm run check:deployment`. For a new production database, use the explicit one-time bootstrap opt-in described above.
5. Start the application and require `/api/ready` to report readiness. Refresh existing tabs so the editor and server use the same code.
6. Review business settings and check the configured host/provider sandbox flows before enabling live payment or email accounts.

Startup adds the two directory indexes; it does not reprice saved invoices, remove receipts, reset the outbox or replace business data. Deploying this source is still a separate operation from building the archive. See [Deployment](DEPLOYMENT.md) for host, proxy, payment, email, GST and backup configuration.

## Scope and remaining work

This release completes the reviewed fixes and verification work. Proposed new modules such as credit notes/refunds, expanded permission roles, expenses/import tools, an owner dashboard and offsite backup storage remain separate feature work. Existing administrator/staff access, dashboard, imports and local backups retain their documented capabilities.

Executed checks establish the specific covered behavior with synthetic data and native database transactions. They do not certify the user's Hostinger configuration, live provider accounts, production capacity or an unprovided business database. The latest [verification record](VERIFICATION.md) identifies the runtime, exact counts and practical limits.

### Primary implementation references

- [Playwright test fixtures](https://playwright.dev/docs/test-fixtures)
- [Playwright continuous integration](https://playwright.dev/docs/ci-intro)
- [MongoDB collation and case-insensitive index behavior](https://www.mongodb.com/docs/manual/core/index-case-insensitive/)
