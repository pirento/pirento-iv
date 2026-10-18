# Code guide

A map for developers who are new to this codebase: where things live, how a request moves through
the layers and which files to touch for a common change. For the database design and the safety
rules behind payments, email and transactions, read [Architecture](ARCHITECTURE.md).

## Start here

Read these files in order. Each one starts with a comment that explains what it does.

1. `server.js`: starts the process (settings, production checks, HTTP server, shutdown).
2. `src/services/backend.js`: creates every service once and wires them together.
3. `src/routes/api.js`: every `/api` URL and the controller that handles it.
4. `src/controllers/pages/workspace-controller.js`: which EJS view each `/workspace/...` URL shows.
5. `src/services/workspace-service.js`: the core business rules (numbering, totals, payments).

## Folder map

| Folder                     | What is inside                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/config/`              | Settings (`.env`), MongoDB connection, indexes and transaction locks, production preflight.             |
| `src/routes/`              | URL tables: `api.js` (JSON API) and `pages.js` (HTML pages and static files).                           |
| `src/middleware/`          | Security headers, access checks for each business, error types and the JSON error handler.              |
| `src/controllers/api/`     | One file per API area. Every handler has a `// METHOD /api/...` comment above it.                       |
| `src/controllers/pages/`   | Page controller and the `helpers` object used inside EJS views.                                         |
| `src/models/`              | All MongoDB reads and writes (`repositories.js`) plus page, ledger and directory queries.               |
| `src/services/`            | Business logic, grouped by feature (auth, documents, ledger, recurring, integrations, operations).      |
| `src/services/validation/` | zod schemas for everything the API accepts.                                                             |
| `views/`                   | EJS templates. Each starts with a `<%# ... -%>` comment naming its URL and browser script.              |
| `public/js/`               | Browser scripts (plain ES modules, no build). `core/` has helpers used by every page.                   |
| `public/css/`              | `app.css` (global) and `management.css`, plus page-specific files.                                      |
| `shared/`                  | Code used by both server and browser: prices, totals, dates, status, PDF layout.                        |
| `scripts/`                 | npm command entry points. Each header names its `npm run` command.                                      |
| `tests/`                   | Unit tests (`tests/*.test.js`), MongoDB tests (`tests/integration/`), browser tests (`tests/browser/`). |

## How a request flows

**A page (HTML).** The browser opens `/workspace/<businessId>/invoices`.

1. `src/routes/pages.js` sends it to `workspace()` in `src/controllers/pages/workspace-controller.js`.
2. The controller reads the URL (`public/js/core/workspace-route.js`), checks admin-only pages and
   loads the page data with `src/services/pages/workspace-data.js`.
3. It renders `views/layouts/workspace.ejs`, which includes the page view (here
   `views/workspace/documents.ejs`) and puts the page data in `<script id="page-data">`.
4. The page script (`public/js/workspace/documents.js`) reads that data with `getPageData()` and
   calls the JSON API for any action.

**An API call (JSON).** The editor saves a new invoice with `POST /api/documents`.

1. `public/js/documents/editor.js` sends the form with `api()` / `sendJson()` from `public/js/core/api.js`.
2. `src/routes/api.js` runs the security headers, JSON body parser, sign-in check
   (`auth.requireSession`) and business access check (`src/middleware/access.js`).
3. `create` in `src/controllers/api/documents.controller.js` validates the body with
   `documentSchema` (`src/services/validation/validation.js`).
4. `src/services/documents/document-writes.js` opens a database transaction, calls
   `newDocument()` in `workspace-service.js` (number, totals, snapshots) and saves through
   `db.models` (`src/models/repositories.js`).
5. Any thrown error becomes a JSON response in `src/middleware/api-errors.js`.

## Where to change things

| I want to...                         | Files                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an API endpoint                  | handler in `src/controllers/api/<area>.controller.js`, route in `src/routes/api.js`, schema in `validation.js`, logic in a service or model.                                                                                                                              |
| Add a workspace page                 | view in `views/<area>/`, view name in `WORKSPACE_VIEWS` (`public/js/core/workspace-route.js`), `bodyView`/title/stylesheets in `workspace-controller.js`, data in `workspace-data.js`, sidebar link in `navigation()` (`view-helpers.js`), script in `public/js/<area>/`. |
| Change a price or tax calculation    | `shared/types.js` (line amounts, totals, GST) and `shared/decimal.js`. Both server and browser use them.                                                                                                                                                                  |
| Change the PDF / printed layout      | `shared/pdf.js` (PDF), `views/documents/preview.ejs` (on-screen preview), `shared/template-presets.js` (built-in formats).                                                                                                                                                |
| Change a database query or index     | `src/models/*.js`; indexes are created in `src/config/database.js`.                                                                                                                                                                                                       |
| Change email sending or reminders    | `src/services/integrations/email/` (`mailer.js`, `payment-reminders.js`, `reminder-rules.js`).                                                                                                                                                                            |
| Change Razorpay / Cashfree behaviour | `src/services/integrations/payments/` (`payment-gateways.js` picks the provider for each business).                                                                                                                                                                       |
| Change settings / environment        | `src/config/environment.js`, `src/config/production.js` and `.example.env` (keep it blank).                                                                                                                                                                               |
| Change styles                        | `public/css/app.css` (global, has section comments) or the page file listed in `pageStylesheets` in `workspace-controller.js`.                                                                                                                                            |
| Change staff permissions             | `src/middleware/access.js` (what each level may do) and `STAFF_PERMISSIONS` in `src/services/auth/auth.js`.                                                                                                                                                               |
| Change the GST return (GSTR-1)       | `src/services/pages/gstr1.js` (tables and CSV), `gstr1Invoices()` in `src/models/workspace-queries.js`, `views/gst/gstr1.ejs`.                                                                                                                                            |
| Change expenses or credit notes      | `src/controllers/api/expenses.controller.js`, `src/controllers/api/credit-notes.controller.js`, `gstAmounts()` in `shared/types.js`, views in `views/expenses/` and `views/credit-notes/`.                                                                                |
| Change the Reports page              | `src/services/pages/reports.js` (figures), `reportData()` in `src/models/workspace-queries.js`, `views/reports/index.ejs`.                                                                                                                                                |

## Rules to keep

- **Do calculations in `shared/`.** The server and the browser must give the same totals. The
  server result is the one that is saved.
- **Use exact money maths.** Line prices use `shared/decimal.js` (exact decimal, half-up).
  Ledger, receipt and installment checks work in whole paise (`shared/money.js`).
- **Scope everything by business.** Records carry `organizationId`. Do multi-record writes inside
  `db.transaction(action, { organizationId })`. For an existing record, use `transactionForRecord`.
- **Validate at the controller.** Parse `req.body` with a zod schema before it reaches a service.
  Throw `HttpError(status, message)` for expected failures.
- **Keep views simple.** Views get data from controllers and never call the database. Use `<%= %>`
  (escaped) for anything a user typed.
- **Read documents through `db.models`.** Saved documents and email payloads hold `stored-image:<hash>`
  references instead of images (`src/models/image-store.js`); the models put the images back. A raw
  collection read returns the references.
- **Use India dates.** Use `indiaBusinessDate()` (`shared/business-date.js`) for "today", not the
  server's clock date.

## Comment style used in this code

- Every file starts with a short header: what the file is for and who uses it.
- Exported functions have a `/** ... */` or `//` line that explains what they return or why they exist.
- API handlers have a route comment above them, e.g. `// PUT /api/documents/:id`.
- Long files are split with section comments (`// --- Sessions ---`); `app.css` uses `/* --- Buttons --- */`.
- EJS views start with `<%# ... -%>`. The `-%>` removes the line break, so the page output stays the same.

## Checking a change

```bash
npm run format:check   # Prettier
npm run check          # syntax of every .js file + compile every EJS view
npm run lint           # ESLint
npm test               # unit tests (no database needed)
npm run verify:local   # everything, including MongoDB and browser tests (needs mongod installed)
```

See [Verification](VERIFICATION.md) for the database and browser test setup.
