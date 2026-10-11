# Venturecore Workspace

An invoice and business workspace using **EJS, JavaScript, Express MVC and MongoDB**.

The frontend consists of real server-rendered EJS pages and ordinary browser JavaScript. There is no React, TypeScript or Vite build. The existing invoice calculations, financial locks, organization access rules, provider adapters and saved-document behavior have been carried into this structure.

**Hindi quick start:** Node.js 24.5+ install karein, MongoDB replica set start karein, `.example.env` ko copy karke `.env` banayein aur usmein apne database aur initial admin details bharein, phir `npm ci` aur `npm start` chalayein. `.env` git mein commit nahi hoti, isliye passwords aur API keys wahin rakhein.

## Current release — 2.5.0

Decimal half-up pricing for new financial work, reliable saves when browser storage is blocked, server-paged contacts and catalog, one production startup preflight and maintained browser verification. Release notes, API contract changes and upgrade instructions for every version are in the [Changelog](docs/CHANGELOG.md).

**Upgrade:** back up the existing database, preserve private configuration, stop older application/worker processes, replace the complete source and browser assets, then restart. Production startup refuses an unintended empty database; use `IV_ALLOW_NEW_DATABASE=true` only for an intentional first deployment and turn it off afterward.

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

Copy the template to a private file, then fill these values in **`.env`**:

```bash
cp .example.env .env
```

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

When `.env` exists the application reads it instead of `.example.env`; hosting environment variables override either file. `.env` is ignored by git and excluded from release packages, so passwords and provider keys stay out of source control. Filling `.example.env` directly still works for existing setups, but that file is tracked by git and the packaging check refuses to ship it with values, so prefer `.env` or hosting environment variables. No `.env` file or merchant credentials are supplied.

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

The project follows conventional **Model–View–Controller (MVC)** with a separate service layer. See [Architecture](docs/ARCHITECTURE.md) for the boundaries and database design.

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
- [Changelog: release notes, API changes and upgrade steps](docs/CHANGELOG.md)
- [Optional disposable synthetic preview](docs/SYNTHETIC-PREVIEW.md)

The supplied source archive contained no live business database. Import tooling is included, but no unprovided customer database or external provider account has been migrated or activated. Live payment, email and GST checks require your credentials and the target hosting environment.
