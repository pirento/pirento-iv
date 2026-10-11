# Venturecore Workspace

An invoice and business workspace using **EJS, JavaScript, Express MVC and MongoDB**.

The frontend consists of real server-rendered EJS pages and ordinary browser JavaScript. There is no React, TypeScript or Vite build. The existing invoice calculations, financial locks, organization access rules, provider adapters and saved-document behavior have been carried into this structure.

**Hindi quick start:** Node.js 24.5+ install karein, MongoDB replica set start karein, `.example.env` mein apne database aur initial admin details bharein, phir `npm ci` aur `npm start` chalayein. `.env` banana ya file rename karna zaroori nahi hai.

## Current release — Phase 7, version 2.5.0

This is the complete updated application, including the earlier phases. Phase 7 completes the reviewed reliability work and adds maintained browser verification to the source package.

**Hindi:** Naye invoice ki decimal rounding theek hai; purane saved invoice ka agreed amount apne aap nahi badlega. Browser notification storage unavailable ho tab bhi contact/product save aur logout complete hote hain. Contacts aur catalog ab 50 records per page dikhate hain; editor 20-record search pages use karta hai aur CSV mein saare matching records milte hain. `.example.env` ko directly fill karke setup ab bhi supported hai.

| Phase 7 area              | Included behavior                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact decimal pricing     | Decimal half-up calculation for new financial work, with a saved rounding-policy marker. Both `0.5 × 20.15` and `1.25 × 8.06` produce ₹10.08. Historical amounts are preserved until an editable draft is financially changed. |
| Reliable save/navigation  | Optional toast and logout storage errors cannot turn a successful server action into a reported failure. Critical draft/request recovery keeps its existing protection.                                                        |
| Production startup        | Normal production startup and the Hostinger entry use the same environment selection and read-only database preflight before initialization.                                                                                   |
| Release configuration     | Packaging and readiness checks reject duplicate template keys, malformed assignments and populated private settings, including values hidden behind a later blank duplicate.                                                   |
| Contacts and catalog      | Server search, filters, 50-row pages, complete filtered CSV, 20-row editor lookups, and selected-record hydration for archived records and draft returns. Tenant and record IDs use exact comparisons.                         |
| Reproducible verification | Included Playwright tests, strict native-test prerequisites, an isolated local replica-set runner and a GitHub Actions workflow.                                                                                               |

See [Phase 7 behavior and upgrade instructions](docs/PHASE-7.md) and [current verification results](docs/VERIFICATION.md). The original Phase 5–6 checkpoint documents are retained as historical records; their old environment limitations do not describe this release.

**Upgrade:** back up the existing database, preserve private configuration, stop older application/worker processes, replace the complete source and browser assets, then restart. Startup adds the two directory indexes. There is no historical-invoice repricing or destructive data migration. Production startup now deliberately refuses an unintended empty database; use `IV_ALLOW_NEW_DATABASE=true` only for an intentional first deployment and turn it off afterward.

## Included Phase 4 release — 2.4.0

This complete ZIP includes every earlier phase and adds account-session controls, administrator security history, shared authentication request limits, safe business transaction scopes and the remaining payment/ledger/reminder fixes.

**Hindi:** **My sessions** mein apne active logins dekh kar ek session ya baaki sab sessions sign out kar sakte hain. Admin **Security activity** mein account history dekh sakta hai aur **Team access** se kisi member ke sessions end kar sakta hai. Purani receipt rounding/correction compatibility fix hai; automatic reminders ab relevant due dates ko indexes se select karte hain.

| Phase 4 area                  | Result                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared account protection     | MongoDB request counters preserve login/signup/reset limits across application instances and restarts; unavailable protection returns a controlled 503.                                                                                    |
| Account sessions              | Own sessions, timestamps, pagination, current-session indication, individual revocation and sign-out-others with confirmation.                                                                                                             |
| Administrator activity        | Filtered, paginated account history, safe before/after access details and selected-account session revocation.                                                                                                                             |
| Business writes               | Fixed organization stripes allow different stripes to overlap; the exclusive fallback still protects global settings, account administration and recovery.                                                                                 |
| Pending correctness/read work | Consistent legacy receipt/payment rounding, an exact overpayment guard, corrected overdue boundaries, parent-invoice ownership for legacy receipt voids, one receipt-history read per statement and indexed automatic-reminder candidates. |

**Upgrade requirement:** stop all older application and worker processes before starting 2.4.0. Old writers cannot coordinate with the new stripe protocol. Preserve the existing database and private configuration; startup creates the additional schema. `.example.env` adds optional **`TRUST_PROXY=`**, left blank until the actual hosting proxy peers are known. No new provider credentials are required.

See [Phase 4 workflows, API, upgrade and pending-work status](docs/PHASE-4.md), [Deployment](docs/DEPLOYMENT.md) and [final verification results](docs/VERIFICATION.md). The transaction/query improvements are verified with native MongoDB and controlled fixtures; production capacity and live provider/hosting setup still depend on the target environment.

## Included Phase 3 changes — 2.3.0

This is the complete project, including all Phase 1 and Phase 2 changes. The new **Receivables** section adds customer ledgers, payment reminders and recurring invoice schedules using the same EJS, JavaScript, Express MVC and native MongoDB architecture.

**Hindi:** Customer ledger mein har contact ka received, outstanding aur overdue balance dekh sakte hain. Statement par date filter, complete CSV aur Print / Save PDF hai. Payment reminder pehle preview hota hai, phir queue hota hai; automatic reminders har business ke liye alag enable karne honge. Recurring schedule se har due date ka **draft invoice** banta hai, jise review karke issue/send karna hai.

| Phase 3 area         | Result                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer ledger      | Scoped customer balances, archived contacts, dated invoice/receipt/void entries, opening/closing balances where history permits, complete CSV and printable statements.           |
| Payment reminders    | Invoice/installment eligibility, manual preview and queue, daily duplicate protection, delivery history and administrator-managed reminder timing per business.                   |
| Recurring invoices   | Weekly/monthly/quarterly/yearly schedules, month-end anchors, frozen commercial inputs, current identity checks, reviewable drafts, pause/resume and occurrence/activity history. |
| Recovery and workers | A bounded shared automation runner, transactional duplicate prevention, graceful draining, reminder opt-out and recurring pause after database restore.                           |

Ledger statements use **current invoice status** and saved transaction dates. Where older records lack dated receipts, the UI explicitly marks incomplete history instead of calculating an unsupported historical balance. Automatic reminders are off by default. Recurring schedules start paused unless activation is explicitly selected; generated drafts are never automatically issued, charged or emailed.

Open [Phase 3 workflow, API and upgrade notes](docs/PHASE-3.md) for exact behavior, and [verification results](docs/VERIFICATION.md) for the completed checks. New collections/indexes are created on application startup; existing invoice, receipt and provider data is retained. Phase 3 introduced no new environment variables; Phase 4 adds optional `TRUST_PROXY`. Keep private `.example.env` values when replacing source, and upgrade the server and browser assets together.

## Included Phase 2 changes — 2.2.0

This full release includes the Phase 1 correctness fixes and implements the next six reviewed areas: page-specific data loading, fast backup inventory, renewable email worker leases, readiness and structured diagnostics, an accessible mobile menu, and explicit local draft controls.

**Hindi:** Invoice lists ab 50 records per page dikhati hain. Search aur filters poore matching data par chalte hain; CSV mein sabhi matching records aate hain. Mobile menu keyboard aur touch dono se close hota hai. **Start fresh** se naya local draft shuru kar sakte hain; pehle bheji hui save request ka result unknown ho to **Retry save** se use resolve karna zaroori hai.

| Phase 2 area      | Result                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace loading | Each normal page loads its own dependencies. Lists use projected records; previews and editors fetch the selected full document. Overview totals still cover all records. |
| Backup navigation | Normal pages do not read backup inventory. The Backups page reads small metadata; a download still verifies the complete snapshot and checksum.                           |
| Email workers     | Each claim has an expiring token and heartbeat. A stale worker cannot update a newer claim. Shutdown stops new claims and drains the active delivery.                     |
| Operations        | `/api/ready` reports database/recovery readiness, safe JSON logs carry server-generated request IDs, and accepted work gets a bounded shutdown grace period.              |
| Mobile menu       | Escape, outside click, close button, focus management and background scroll protection are implemented.                                                                   |
| Local drafts      | Confirmed Start fresh creates a new draft. Discard unsaved changes reloads the saved document. Unknown creation results remain protected.                                 |

See [Phase 2 changes and upgrade notes](docs/PHASE-2.md) and [verification results](docs/VERIFICATION.md). Upgrade the server and browser assets together, stop all older email workers before starting this version, and refresh existing tabs. New query/lease indexes are created at startup; `.example.env` and the existing business calculation rules are retained.

## Included Phase 1 fixes — 2.1.0

This release fixes the reviewed customer handoff, stale document updates, duplicate creation after a lost response, receipt amount/date validation, gateway business dates, and cancellation of unattempted invoice emails.

**Hindi:** Contact ab sirf usi draft mein select hoga jahan se add kiya tha. Purani copy save karne par conflict dikhega aur aapke unsaved changes screen par rahenge. Network error ke baad **Retry save** wahi request check karega. Future manual receipts aur ek paise se chhoti amounts reject hongi. Gateway receipts ki date India timezone mein hogi.

Existing unversioned documents are read as revision zero until their first update. New documents expose a `version`, and full-document and installment-plan API updates must send that version. New browser drafts send a persisted `requestId`; a retry returns the same saved document. See [Phase 1 changes and upgrade notes](docs/PHASE-1.md) for the exact API contract, recovery behavior and verification scope.

## Start locally

Requirements:

- Node.js **24.5+ (24 LTS recommended)** and npm. The one-time SQLite import command uses Node's built-in SQLite module.
- A MongoDB **replica set**, such as MongoDB Atlas or the local Docker setup below. An ordinary standalone `mongod` is rejected because financial changes require transactions.
- Docker with Compose only if using the included local database setup.

From this project directory:

```bash
npm ci
# Skip this command if using Atlas or an existing replica set.
docker compose up -d --wait
```

Edit **`.example.env` directly** and fill these values:

| Setting                  | What to enter                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`            | Your MongoDB connection string. The default matches the included local replica set.               |
| `MONGODB_DATABASE`       | The database name, initially `venturecore_workspace`. Use a new name when importing or restoring. |
| `INITIAL_ADMIN_EMAIL`    | An email address you control for the first administrator.                                         |
| `INITIAL_ADMIN_NAME`     | The administrator's display name.                                                                 |
| `INITIAL_ADMIN_PASSWORD` | A unique password of at least 12 characters.                                                      |

Then run:

```bash
npm start
```

Open **http://localhost:3001** and sign in with the administrator details. For development with server reload, use `npm run dev` instead. Browser assets are served directly; refresh the page after editing them.

After the first successful owner login, remove both `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from the local configuration or hosting settings. Changing these startup values does not reset an existing administrator's password. Staff use Signup, then an administrator approves them and assigns their organizations in **Team access**.

The application loads `.example.env` directly. Hosting environment variables override the file. Distributed credential fields are blank; fill them privately. No `.env` file or actual merchant credentials are supplied.

## What is included

| Area               | Available behavior                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts           | Shared login/signup/reset limits, account approval, staff assignments, disable/reactivate, password reset, own/admin session controls and security activity. |
| Organizations      | Five Venturecore divisions, independent Shri Sarraf, additional organizations, separate seller identities, GST registrations, banks and branding.            |
| Contacts           | Customers, B2B buyers and vendors; search, edit, archive/restore, shipping defaults and GST lookup.                                                          |
| Customer ledger    | Customer balances, current-status invoice/receipt/void statements, date filters, full CSV and printable reports with explicit history limitations.           |
| Payment reminders  | Manual preview/queue, unpaid invoice/installment targets, per-business automatic timing and delivery history.                                                |
| Recurring invoices | Weekly, monthly, quarterly and yearly schedules that create reviewable drafts, with pause/resume, duplicate protection and retained history.                 |
| Documents          | Invoices, quotations, proformas and delivery challans; drafts, preview, print, PDF and CSV exports.                                                          |
| Financial workflow | Financial-year numbering, invoice conversion, issued/final locks, partial receipts, payment correction and audit events.                                     |
| Catalog            | Products/services, SKU and HSN/SAC, archive/restore, duplication, business-product selection and saved pricing.                                              |
| Pricing            | Standard quantity/rate, recurring periods and detailed jewellery weight/making calculations.                                                                 |
| Formats            | Fifteen built-in presets, five layouts, custom colors, columns, fonts, paper settings, logos and signature/stamp/QR areas.                                   |
| Installments       | Equal, monthly/weekly, optional down payment and 70/20/10 schedules; receipts allocated to the earliest installment.                                         |
| Payments and email | Business-specific Razorpay/Cashfree links, signed webhook handling, payment synchronization, Resend email, PDF attachments and retry history.                |
| Operations         | Administrator-only verified MongoDB snapshots, scheduled backups, restore/recovery commands and SQLite import.                                               |

Each organization owns its contacts, catalog, products, formats and documents. Historical documents keep saved seller, buyer, format, product, branding and pricing details. Updating a current business or contact does not silently rewrite issued documents.

### First business setup

1. Open **Business settings** for the selected organization. Review legal identity, address/state, GST registrations, numbering, bank details and support contacts.
2. Upload the organization's logo, signature and payment QR where needed. PNG, JPEG and WebP uploads are supported up to 500 KB per image. Workspace branding remains separate from invoice branding.
3. Add contacts and products/services. Enter real prices and appropriate tax classifications; the software does not infer them from a business name.
4. Choose a format and create a quotation, proforma, invoice or delivery challan. New organizations need a saved seller GST registration before charging GST.
5. Save and preview the document. Issue financial documents when ready, then record receipts on the **Payments** page.
6. Configure provider credentials only for the businesses that need online payments or email. The **Payments & email** page displays status and the relevant webhook path.

### Business rules retained

- Amounts are in INR. Discount, GST, financial-year numbering, rounding and pricing use the shared JavaScript business functions.
- Quotation/proforma conversion returns the existing invoice when repeated. Delivery challans carry quantities and shipping information without financial charges.
- Drafts can be edited financially; issued documents and invoices with receipts lock financial fields. Paid/final invoices lock editing. An incorrect manual receipt can be voided with a reason, preserving the record and history.
- Overpayments are rejected. Repeated receipt requests and provider callbacks cannot credit the same receipt twice. A zero-value invoice requires explicit finalization.
- An installment schedule must equal the invoice total in integer paise. It schedules existing invoice value and adds no interest or automatic debit.
- Archived contacts and products remain available to historical documents. A format change in the format library does not change saved document snapshots.
- Independent businesses do not inherit Venturecore merchant or outgoing-email credentials. Manual receipts record operator input; they do not verify a bank transaction.

## MVC structure

| Location                 | Responsibility                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `server.js`              | Read configuration, start HTTP/background workers and shut down cleanly.  |
| `src/app.js`             | Assemble the API and EJS application.                                     |
| `src/config/`            | Environment, MongoDB connection/indexes and business defaults.            |
| `src/models/`            | Native MongoDB repositories and first-use seeds.                          |
| `src/controllers/api/`   | HTTP controllers grouped by business feature.                             |
| `src/controllers/pages/` | Authorized page data, view selection and safe view helpers.               |
| `src/routes/`            | API paths and EJS page routes.                                            |
| `src/services/`          | Business rules, authentication, payments, email, GST, PDF and operations. |
| `views/`                 | EJS layouts, pages and partials.                                          |
| `public/`                | Browser JavaScript, CSS and bundled fonts.                                |
| `shared/`                | Reusable calculations, formats, business identity and PDF definitions.    |
| `scripts/`               | Source checks, database backup/recovery and SQLite import.                |
| `tests/`                 | Render/business checks and isolated MongoDB integration tests.            |

The requested “MVS” structure is implemented as conventional **Model–View–Controller (MVC)** with a separate service layer. See [Architecture](docs/ARCHITECTURE.md) for the boundaries and database design.

## Commands

| Command                                                                    | Purpose                                                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                                                                | Start the persistent EJS/API server.                                                                                         |
| `npm run start:hostinger`                                                  | Start with production and existing-database checks; explicit first-launch opt-in is supported.                               |
| `npm run start:synthetic-preview`                                          | Start the original disposable testing mode using a separate MongoDB URI.                                                     |
| `npm run check:deployment`                                                 | Check hosting configuration and inspect MongoDB read-only.                                                                   |
| `npm run package:preview`                                                  | Produce application-only ZIP/tar archives with a blank configuration template.                                               |
| `npm run package:synthetic-preview`                                        | Produce a separate archive whose start command selects disposable preview.                                                   |
| `npm run dev`                                                              | Start with Node's file watcher.                                                                                              |
| `npm run build` / `npm run check`                                          | Check JavaScript syntax, compile all EJS templates and reject leftover TypeScript/JSX files. No frontend bundle is required. |
| `npm test`                                                                 | Run the database-independent template/behavior tests.                                                                        |
| `npm run test:integration`                                                 | Require a dedicated `MONGODB_TEST_URI` and run every native suite; missing setup or skipped tests fail the gate.             |
| `npm run test:integration:optional`                                        | Explicit developer-only allowance for missing test configuration; reports that database tests did not run.                   |
| `npm run test:browser:install`                                             | Install Playwright Chromium for verification; not required to run the application.                                           |
| `npm run test:browser`                                                     | Run included browser workflows against a dedicated test replica set.                                                         |
| `npm run verify:release`                                                   | Run source, unit, native database, browser and readiness gates in sequence.                                                  |
| `npm run verify:local`                                                     | Create an isolated local test replica set using an installed `mongod`, run release verification, then remove test data.      |
| `npm run format` / `npm run format:check`                                  | Format or check the JavaScript, styles, JSON and documentation.                                                              |
| `npm run db:backup`                                                        | Create a verified MongoDB Extended JSON snapshot.                                                                            |
| `npm run db:restore -- --file=... --manifest=... --database=...`           | Restore into a new empty database and place it on recovery hold.                                                             |
| `npm run db:resume -- --database=... --acknowledge-reconciled`             | Release the startup hold after an operator reconciles accounts, payments and email.                                          |
| `npm run db:import-sqlite -- --source=... --database=... --confirm-import` | Import the original schema-v5 SQLite database into a new MongoDB database.                                                   |

## Detailed guides

- [Architecture and feature boundaries](docs/ARCHITECTURE.md)
- [MongoDB migration and recovery](docs/MIGRATION.md)
- [Deployment and provider configuration](docs/DEPLOYMENT.md)
- [Verification results and how to run tests](docs/VERIFICATION.md)
- [Phase 7 decimal pricing, directory queries, startup and release verification](docs/PHASE-7.md)
- [Phase 4 account security, transaction scopes and pending fixes](docs/PHASE-4.md)
- [Phase 3 customer ledger, reminders and recurring invoice schedules](docs/PHASE-3.md)
- [Phase 2 performance, worker, operations and usability changes](docs/PHASE-2.md)
- [Phase 1 fixes, API changes and upgrade notes](docs/PHASE-1.md)
- [Optional disposable synthetic preview](docs/SYNTHETIC-PREVIEW.md)

The supplied source archive contained no live business database. Import tooling is included, but no unprovided customer database or external provider account has been migrated or activated. Live payment, email and GST checks require your credentials and the target hosting environment.
