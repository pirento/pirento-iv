# Venturecore Solutions Private Limited INV

A persistent invoice, quotation, proforma, shipping and catalog workspace for **Venturecore Solutions Private Limited**, with five Venturecore brands/divisions and the independent **Shri Sarraf** business:

- Pirento legal
- Pirento ecosystem
- AT Facility
- A T Elevator
- INZARIO SPACE
- Shri Sarraf — independent legal business, with Cashfree and separate seller/payment/email details

Additional organizations can be created in the app. The dashboard header, sidebar and footer follow the selected organization’s name and logo; organizations without a logo display their initials. The workspace logo remains separate and appears in the Organizations overview; it is never inherited by an organization or invoice. Each has its own searchable customers, B2B buyers and vendors, products, services, saved formats, documents, numbering, GST registrations, visual identity and payment details. Venturecore divisions use Venturecore Solutions Private Limited as their legal company; Shri Sarraf uses its own legal/trade identity. Independent businesses never inherit the main company’s gateway or email credentials.

## Run locally

Requires **Node.js 24.5+** and npm.

```bash
npm ci --include=dev
npm run dev
```

On your own development machine, the Vite frontend runs on port `5173` and proxies `/api` to the Express server at `127.0.0.1:3001`. This is local development only; the Codex onboarding environment does not expose a user-facing localhost preview.

For the production build served locally:

```bash
npm run build
npm start
```

The built frontend and API run together on local port `3001`. The API binds to localhost by default. Startup honors the platform HTTPS proxy; never disable certificate verification to work around connectivity failures.

For a website with account login accessible to approved staff, see [Private testing deployment](PREVIEW_DEPLOYMENT.md). It requires a Node.js host with HTTPS and persistent storage. `npm run package:preview` creates an application-only upload archive, excluding private business data and credentials.

For invented-data UI testing on temporary hosting, use the separate [Disposable synthetic preview](PREVIEW-START-HERE.md). `npm run package:synthetic-preview` creates a clearly named Hostinger ZIP and tar archives; only those artifacts change `npm start` to disposable mode. Every preview process starts a new database, shows TEST labels and blocks external integrations. The normal checkout retains its persistent application startup and full test suite.

## Code organization and pages

The frontend is grouped by business feature under `src/features/`, with the workspace shell/navigation in `src/app/` and reusable UI/API/styles in `src/shared/`. Pure business models and calculations live in root `shared/` for both frontend and backend. Server integrations, authentication, database and document rendering have separate directories; tests are collected under `tests/`. See [Architecture](ARCHITECTURE.md) for boundaries and [Security](SECURITY.md) for implemented protections and deployment requirements.

Editors, document preview, payment/email screens and settings use full workspace pages. Page URLs support saved-record refresh/bookmarks and browser Back/Forward. Save a draft to persist entered data; an unsaved form is not a saved invoice. Confirmation actions remain on the page. Native file-picker and print dialogs still belong to the browser.

## Accounts, contacts, payments and email

The public home page provides Login and Signup. A server-provisioned administrator approves new staff and assigns organizations; public signup never grants access to existing company data. **Contacts** supports customers, vendors and B2B buyers. **Payments** includes separate Razorpay and Cashfree links according to the issuing business, and **Email** includes saved PDFs, payment links and notification history. See [Platform setup](PLATFORM_SETUP.md) for first-owner provisioning, access rules, integration settings and limits. Real payment/email activation is pending server credentials, matching merchant webhooks, verified per-business senders and hosted checks. Support defaults to `support@pirento.com` for Venturecore and `support@shrisarraf.com` for Shri Sarraf; these are contact/Reply-To settings, not proof that an outgoing sender has been verified.

## First use

1. Select an organization and open **Business settings**. Review its legal/trade name, business relationship, default GSTIN/address/state, optional additional GST registrations, PAN/CIN, support contact and bank details. Venturecore divisions and an independent business have separate seller records. Uploaded legal documents are private source data, not external verification; GSTIN and state are required before charging GST.
2. Upload the logo, signature image and payment QR (PNG/JPEG/WebP, up to 500 KB each), then customize the color, terms and signature caption. QR and bank details are optional and can be added, replaced or removed later for each organization. New organizations start with empty seller/payment details. A Venturecore division can explicitly copy company details; choosing an independent business clears copied identity/payment defaults. Each keeps its own names, numbering and invoice logo. The supplied red/dark Venturecore logo remains the shared workspace logo on the Organizations overview; upload each organization’s own logo for its dashboard and documents. Invoice and quotation prefixes contain up to four letters/numbers and must be unique across divisions.
3. Open **Products & services** to add offerings with a name, description, SKU, HSN/SAC, selling rate, unit and GST rate. Suggested starting points are optional editable ideas; no rates, tax classifications or customer data are invented.
4. Open **Invoice formats** for 15 ready-to-use templates spanning business, legal, consulting, maintenance, retail, wholesale, design and dispatch. Customize five layouts (Modern, Classic, Minimal, Ledger, Sidebar), colors, columns, table style, font, margins, logo/signature/QR sizes and A4/A5/Letter portrait or landscape paper. Upload a format-specific logo or inherit the company logo. Each organization has one default format; duplicate any design to make another.
5. In **Contacts**, save customers, B2B buyers and vendors manually or with GST lookup. A contact can have more than one role. Edit/archive/restore records without losing saved invoice history; GSTIN is optional for unregistered contacts. These are business records, separate from staff login accounts.
6. Create a **Quotation**, **Proforma invoice**, **Invoice** or **Delivery challan**. Search the selected organization’s saved contacts by name, contact person, phone, email, GSTIN/PAN or address, and filter by customer/B2B buyer/vendor. Choose **Seller GST registration**, catalog entries or manual lines, and a saved format, then edit quantities, rates, units, GST rates, discount, place of supply, dates and notes. Adding a new contact from the editor preserves your draft.
7. Save, **Preview**, **Print** or **Download PDF**. PDF download creates a file directly in the browser; Print opens the browser print dialog. Quotations and proformas convert into invoices once; repeating conversion returns the existing invoice. Add a delivery challan from an invoice, or create one separately.
8. Open an invoice’s **Payments** page to record a receipt (amount, date, method, reference, notes). Partial payments reduce the balance; full payment makes the same invoice **Paid / Final** and locks editing. Manually entered receipts are not bank verification. Its Online payments section separately verifies Razorpay captured payments or Cashfree successful payments using that business’s configured merchant account. An incorrect manual receipt can be voided with a reason; its record and audit history remain, and the balance reopens.

9. In **Business settings**, choose the appropriate billing profile. Jewellery items support weight, metal rate and making charges; recurring services multiply units by periods. A draft document can use a custom logo, primary and secondary signature names/images, and a stamp image or blank stamping area. These document-level changes leave organization defaults unchanged.
10. In **Payments**, add an installment/EMI schedule with monthly or weekly due dates, optional down payment and editable installment amounts. The plan must equal the full invoice total. Existing and new receipts apply to the earliest due installment first; the schedule shows received, remaining and overdue amounts. Final invoices lock schedule editing.

CSV export is available from document and catalog lists; invoice exports include received amounts, balance and finalization date. Search and filters apply to exports. Contacts of every role, catalogs, formats and documents belong to the selected organization.

Document lists show 25 records per page with Previous/Next controls and server-side search, status and business-product filters. Dashboard totals include the whole selected organization, independent of the current page. Saved document links resolve directly even when the record is outside the current page. CSV downloads stream all matching records in bounded batches. The legacy `/api/documents` array is capped at 100 records per request and includes `X-Total-Count`, `X-Page` and `X-Page-Size`; API clients should use `/api/documents/page` for the pagination envelope or request pages explicitly. JSON-backed filters and summaries can still require database scans, so pagination is not a claim of unlimited scale.

## Catalog and formats

- Add products and services, edit or duplicate them, search by name/SKU/HSN, and archive or restore old offerings. A nonempty SKU must be unique within an organization, including archived entries.
- Catalog selections copy their descriptions, HSN/SAC, unit, price and GST into document lines. You can negotiate prices on draft documents. Catalog updates never rewrite previously saved documents.
- Archived items are hidden from new-document pickers. Existing documents retain their saved lines, including archived catalog references.
- Create multiple named formats and duplicate a design as a starting point. Each organization always has exactly one default. Set another default before deleting the current one; at least one format must remain.
- Each document stores its chosen format. Editing or deleting a format in the library does not change existing documents. Choose a different format while editing a document to apply another saved design explicitly; issued financial fields remain locked.
- Downloaded PDFs contain selectable text, INR amounts, optional amounts in Indian words, multipage tables with repeated headers and page numbers. PDF generation is local; business data is not sent to a PDF conversion service. PDF code and fonts load only when downloading.
- For reliable logos in downloaded PDFs, upload a PNG/JPEG/WebP in Brand settings. An external HTTPS logo can be omitted with a visible warning if its host blocks browser access. Browser printing and PDF download use the stored paper size and orientation. Uploaded QR/signature images keep their original proportions.

## Business products and industry billing

Pirento ecosystem includes the ten business products provided by the user: **PIRENTO legal, PIRENTO vault, Pirento One, Pirento Capital, Pirento Blank, Pirento AI, Pirento Intern, Pirento Green, Giftox, and Bharat ID BY PIRENTO**. This is a product selector within Pirento ecosystem; the separate Pirento legal organization remains its own division.

Use **Business products** to add/edit product names, descriptions, logos or archive a product. Catalog offerings may be shared across the division or linked to one product. Select a product when creating a document; only that product’s offerings and shared offerings appear. Product/customer/company/pricing details are saved as snapshots. Renaming a product does not rewrite an existing document. Switching an unfinished document to a product with incompatible lines requires an explicit decision to remove those lines.

Billing profiles suggest appropriate units for legal work (hour/case/draft), facility services (person/shift/month), elevators (lift/visit/year), space/interiors (area/seat/room), jewellery and ecosystem subscriptions (license/user/period). Users enter actual rates and GST classifications; no market rates are guessed.

- **Standard:** quantity × rate per unit.
- **Recurring:** quantity × number of periods × rate per unit per period. For example, four people over two months at a per-person monthly rate.
- **Jewellery:** quantity is the number of identical items. Gross and stone weight are entered **per item**, in grams; net metal weight is gross minus stone weight. The rate is per gram of net metal at the entered purity. Making may be fixed per item, per gram, or a percentage of metal value. Optional wastage is a percentage of metal value; stone value and other charges are per item. Each component is rounded to paise, then the document discount and chosen GST rate apply to the complete line amount. Purity is descriptive; it does not silently adjust the entered rate. Use separate lines when a component needs a different tax treatment.

The invoice shows the pricing breakdown, not just a hidden calculated total. Delivery challans retain quantities without carrying financial pricing. Original PNG/JPEG images are embedded without resizing; WebP is encoded to PNG only for PDF compatibility, while original uploads stay unchanged.

## Installments, signing and branding

The EMI feature schedules amounts already on the invoice; it is not a lender, interest calculator, automatic debit or payment gateway. No interest or late fee is silently added. Plans include any money already received and must sum to the invoice total in integer paise. Monthly generation uses the anchor day (31 January → 28 February → 31 March), and paise remainders are distributed exactly. Payments reduce the oldest due installments first; a reasoned void recomputes their balances. Schedule changes and removal are recorded in the invoice activity history. For invoices with a plan, overdue indicators follow installment dates and the printed final due date is the last installment date.

Use **Dashboard branding → Edit organization logo**, or **Business settings → Logo & invoice design**, to upload or replace the selected organization’s logo. Saving updates that organization’s dashboard branding immediately, and the saved name/logo returns after refresh. Other organizations keep their own branding. The separate workspace logo, optional business-product logo, saved-format logo and draft-document override remain independent settings. A document’s explicit custom/hidden logo choice takes priority; otherwise it uses the format, saved business product or saved organization logo. The workspace logo is never an invoice fallback. To use a newly updated organization logo on an existing draft, use **Use current organization logo** in its branding section. Issued/final documents retain their saved identity.

Secondary signatory and stamp areas can contain uploaded images or stay empty for signing/stamping a printed copy. Captions can include the authorized person’s name/designation. Template toggles and dimensions control their appearance without cropping the uploaded image.

## Existing workspace migration

Database schema version 2 corrects the five original division names and legal company name, adds Shri Sarraf, and creates a Standard invoice format for each organization. Existing organization IDs, prefixes, customers and financial records are preserved. Saved historical issuer/customer details and amounts remain intact; migration records their legacy format before changing live company settings. The migration runs once and respects subsequent user edits.

Schema version 3 adds proformas and delivery challans, payment records and document events, and fills missing built-in templates up to 15 per organization. Existing formats, customizations and historical document snapshots are preserved. Legacy invoices already marked paid receive an explicitly identified legacy receipt rather than losing their recorded paid status.

Schema version 4 adds independent workspace settings, organization billing profiles and the ecosystem business-product hierarchy. It preserves old settings, catalog links and document snapshots.

The business identity upgrade separates Shri Sarraf from the Venturecore defaults, supports organization-owned additional GST registrations and records the selected seller registration in draft/document snapshots. Issued financial and payment identities remain historical snapshots; adding an organization or changing current settings does not move its invoices to another merchant. Per-business credentials and notification profiles are separate from document data.

The installed workspace was backed up with SQLite's online backup API before the migration. For future upgrades, back up your own data first.

## Document behavior

- Currency is INR. Amounts are rounded to two decimal places. GST is calculated after the percentage discount. The chosen seller GST registration supplies the issuer state/address/GSTIN; only registrations saved on the selected business are available. Matching supplier state and place of supply produces CGST/SGST; different states produce IGST.
- Numbers include prefix, Indian financial year and sequence, e.g. `P2EI/2627/0001`. Numbers are assigned on draft save, remain within 16 characters and are not reused after deletion.
- Saved documents contain a snapshot of customer and issuer details. Editing a customer or organization does not silently change earlier documents.
- A financial edit to a draft refreshes its snapshots from the current customer and organization records. Metadata-only edits keep the stored snapshots and totals.
- Once issued (non-draft), or when an invoice has active payments, financial fields are locked. Issued documents cannot return to draft. Paid / Final invoices lock all edits; payment corrections are recorded separately with a reason and audit history.
- Quotation/proforma conversion uses the current India date and invoice financial year, preserves quoted amounts/details, and carries forward the original issue-to-due interval. The source document is marked accepted and locked. Custom quotation titles are preserved; the default title becomes Invoice.
- Delivery challans record quantities, recipient, destination, carrier, tracking reference, vehicle and dispatch/delivery dates without prices or taxes. Track draft, dispatched, delivered and cancelled statuses. Shipping details can also appear on regular financial documents.
- New proforma and delivery numbers use the invoice prefix with `P`/`D` before their sequence, such as `P2EI/2627/P0001` or `P2EI/2627/D0001`.
- Receipt amounts use integer paise. Overpayments are rejected; request IDs make retries idempotent. Finalizing a zero-value invoice requires the explicit finalize action.
- Manual receipt dates must be today or earlier in India, and the server enforces this before changing financial or email records. Authenticated Razorpay/Cashfree responses with a future India calendar date enter payment review rather than crediting or finalizing the invoice. Already recorded verified-payment retries retain their original date and receipt.
- Only unlinked drafts without payments can be deleted. Customers referenced by saved documents cannot be deleted.

## GST fetching

By default, **Fetch details** uses the GST public portal with a **CAPTCHA completed by the person using the app**. CAPTCHA cookies remain on the server; opaque challenges expire after three minutes and are single use. Lookup fills the registered name, address, state and GSTIN. It does not promise phone or email data. Review retrieved details before saving.

For **Sandbox GST Search**, set `GST_PROVIDER=sandbox`, `SANDBOX_ENVIRONMENT=test`, `SANDBOX_API_KEY` and `SANDBOX_API_SECRET` in secure server settings, then restart the app. Use the matching test key/secret from Sandbox Console → Settings → API Keys. The application obtains and renews a server-only access token automatically; do not paste a token into the app or expose credentials through `VITE_` variables. **Payments & email** shows the GST provider, environment and whether credentials are present, without revealing their values. A configuration badge does not verify the provider account.

Sandbox test APIs return documented example/mock records only, not actual customer verification. Use matching production credentials and `SANDBOX_ENVIRONMENT=production` for real taxpayer details after checking the account plan. The contact editor clearly labels test responses and requires saving the reviewed form; fetching never creates a customer automatically or changes an organization's seller GST. Do not copy mock customer details into business invoices. Sandbox lookup is shared across the workspace's organizations and is independent of their separate payment/email accounts.

The adapter follows Sandbox's official [Authenticate](https://developer.sandbox.co.in/api-reference/authenticate) and [Search GSTIN](https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/public/search_gstin) contracts: `POST /authenticate` with `x-api-key`/`x-api-secret`, then `POST /gst/compliance/public/gstin/search` with a raw access token and API key. Only the fixed `api.sandbox.co.in` and `test-api.sandbox.co.in` hosts are used. Authentication tokens stay in memory; responses are bounded and validated against the requested GSTIN. Successful results are cached for up to five minutes, simultaneous identical lookups are coalesced, and request limits reduce accidental repeated billable requests. Lookup failures are not automatically retried. Cancelled GST registrations remain labelled with the returned status. Manual entry remains available when the provider is unavailable.

**Live Sandbox status:** the adapter and isolated tests do not establish a live connection. The user's credentials are currently held privately and have not been configured in this environment. Secure key/secret entry, outbound API access and a successful authenticated query remain necessary.

The supplied [reference repository](https://github.com/sivunq/fetch-GST-details-without-using-any-paid-API/tree/25df28e76ce285210292f9321840666f10c0e487) describes this CAPTCHA/cookie flow. It is an incomplete set of snippets without a license. This implementation is independently written; none of its source was copied, and no CAPTCHA bypass or solver is used.

**Live portal status:** the cloud environment blocked `services.gst.gov.in` with a proxy CONNECT 403 during implementation. The environment draft adds that host, but the draft must be reviewed, saved and published before the new policy applies. Live lookup remains unverified until a real CAPTCHA and taxpayer lookup succeed after activation. Portal endpoint behavior may change. If fetching fails, the app shows an error and allows manual entry; it never fabricates taxpayer data.

Another normalized provider can replace the portal flow. Keep `GST_PROVIDER` unset for legacy URL-based selection, or set it to `generic`. Copy `.env.example` to `.env` and configure:

```dotenv
GST_LOOKUP_URL=https://your-provider.example/lookup/{gstin}
GST_API_KEY=your-server-side-bearer-key
```

This is a generic integration contract, not a preconfigured commercial service. The server substitutes a validated GSTIN, sends the optional key as a Bearer token, and expects:

```json
{
  "gstin": "the requested valid GSTIN",
  "name": "Registered legal name",
  "address": "Registered address",
  "stateCode": "27",
  "status": "Active"
}
```

`status` is optional; a `{ "data": { ... } }` wrapper is supported. A provider with another schema/authentication method needs an adapter. Credentials are server-only; do not commit `.env` or put keys in a `VITE_` variable. Provider hostnames also need outbound access.

## Persistence and verification

SQLite data is stored in `.data/workspace.sqlite`, excluded from Git. User-supplied original QR/signature files and previous import assets are preserved privately in `.data/company-assets/`; the current dashboard logo is in `.data/workspace-assets/`. The old company-import JSON is historical input and must not be replayed: it predates independent organization logos and Shri Sarraf’s separate legal/payment identity. Uploaded certificates stay private; their GST-verification QR is not a payment QR. Company settings and document snapshots store their image data. These personal assets and bank details are not source fixtures or public build assets. Override with `DATABASE_PATH`.

Administrators have a full **Database backups** page with manual snapshots, completed backup history and authenticated SQLite/manifest downloads. Backups cover the whole workspace; staff cannot list or download them. Set `BACKUP_ENABLED=true`, `DATABASE_BACKUP_DIR` to a private persistent directory, `BACKUP_INTERVAL_MINUTES=1440` and `BACKUP_RETENTION_COUNT=7` for automatic verified snapshots. The server checks SHA-256, SQLite integrity and foreign keys; unsafe snapshots stop retention cleanup. One application/backup writer owns the directory. Local snapshots are not offsite backups and do not include original attachments or server secrets.

`npm run db:backup` takes a consistent online snapshot; `db:restore` creates a new private database without overwriting existing files. Restored databases revoke sessions/reset tokens, hold queued emails and refuse server startup until account/payment/email reconciliation is explicitly acknowledged with `db:resume`. Acknowledgement does not verify provider history. See [Database operations](DATABASE_OPERATIONS.md) for storage, both download files, recovery and cutover. If copying files instead, stop the server and copy the complete data directory including WAL/SHM files. `npm run check:deployment` reports safe configuration blockers and optional integrations; actual hosting persistence and live APIs still require verification.

```bash
npm test
npm run build
```

Tests cover tax rounding, validation, saved data, organization separation, numbering, conversion, snapshots, financial locks, migration, catalog archival/SKU rules, format defaults, payment totals/idempotency/final locks/reversals, shipping, proforma conversion, long service descriptions, Indian amount words and real multipage PDF generation, plus GST provider/CAPTCHA handling and mutation protections. Use a separate temporary `DATABASE_PATH` for browser tests to keep test records out of business data.

All business APIs require account sessions and enforce assigned organization access. Production requires an HTTPS public origin. Razorpay, Cashfree and transactional email integrations remain inactive for a business until its server credentials, matching webhook registration and verified sender are configured. Global Venturecore settings do not activate Shri Sarraf. Shared workspace email settings still handle password resets. Provider tests use simulated responses and do not establish live payment or email delivery readiness. E-invoice/IRN integration, accounting filing, supplier bills, automated refunds and email delivery/bounce tracking are not implemented. Configure and validate the hosted deployment before using it for live business.
