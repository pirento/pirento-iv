# Private testing website

Run this application as one **Node.js 24.5+ service**, behind a hosting provider's **HTTPS** endpoint, with a **persistent disk**. The Express service serves the built frontend and API together. A provider-assigned HTTPS subdomain is sufficient; buying a domain is unnecessary.

This document prepares a deployment; it does not mean a public website has been created. The Codex onboarding workspace does not provide user-facing localhost previews.

For a disposable test site with invented records and disabled integrations, use [PREVIEW-START-HERE.md](PREVIEW-START-HERE.md) instead. Its separate artifacts never replace the permanent database.

## Hosting settings

| Setting                  | Value                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Install                  | `npm ci --include=dev`                                                                        |
| Build                    | `npm run build`                                                                               |
| Start                    | `npm run start:hostinger` for hosted production; `npm start` for ordinary local startup       |
| Node.js                  | 24.5 or newer                                                                                 |
| `NODE_ENV`               | `production`                                                                                  |
| `HOST`                   | `0.0.0.0`                                                                                     |
| `PORT`                   | Provider-assigned port, or `3001`                                                             |
| `DATABASE_PATH`          | An absolute private file path on the mounted persistent disk, outside the application release |
| `PUBLIC_APP_URL`         | The exact HTTPS website origin                                                                |
| `INITIAL_ADMIN_EMAIL`    | An email controlled by the initial owner, set in server settings                              |
| `INITIAL_ADMIN_PASSWORD` | A unique password of at least 12 characters, entered securely in server settings              |
| Health check             | `GET /api/health`                                                                             |
| Instances / replicas     | One                                                                                           |

Enable verified local database snapshots with `BACKUP_ENABLED=true`, a private persistent absolute `DATABASE_BACKUP_DIR`, `BACKUP_INTERVAL_MINUTES=1440` and `BACKUP_RETENTION_COUNT=7`. The admin **Database backups** page can also create snapshots and download the SQLite file plus its manifest. Keep both for recovery. These copies stay on the server; an offsite destination is not configured. See [DATABASE_OPERATIONS.md](DATABASE_OPERATIONS.md).

When Hostinger asks for an entry file, choose `hostinger-entry.mjs`. Leave `IV_PREVIEW_MODE` absent for the permanent system. The hosted adapter validates production settings before dotenv loading or application imports and refuses an absent or empty expected database. Supply settings in the host's secure environment UI. For first provisioning only, create the private persistent parent directory and set `IV_ALLOW_NEW_DATABASE=true`; remove it after successful owner login and database verification. Do not use this flag to bypass a missing existing business database. Unknown or empty preview mode values fail startup. These guards cannot prove mount durability; verify that storage survives a hosted redeploy.

The runtime uses `tsx` from production dependencies. The build still needs the development dependencies, so keep `--include=dev` for the install/build phase. Run commands from the project root. Do not deploy only `dist`: the service also needs `server/` and root `shared/`, including the common invoice PDF definition. The package script includes all required application roots and the frontend source needed for a host-side build.

Production startup requires the HTTPS public origin. Provision the first administrator securely before opening the site to signup. The home, login and signup pages are public; business APIs require an authenticated account. New signups require admin approval and organization assignments. Signed Razorpay and Cashfree webhook routes are public so the providers can send events; business APIs still require login. Register the organization-specific route in the matching merchant account, and never put a shared preview password in front of those routes. See [PLATFORM_SETUP.md](PLATFORM_SETUP.md) for accounts, provider settings, email and password resets.

Never put passwords into frontend code, a `VITE_` variable, source archives or chat. Remove both initial-admin email/password bootstrap values after the first owner login. Existing passwords are never reset by startup settings. Keep the internal HTTP port private behind the host's HTTPS endpoint.

## Data and persistence

The application creates five Venturecore divisions plus the independent Shri Sarraf business, ten ecosystem business products and fifteen templates per organization in a new database. A fresh database does **not** contain uploaded legal/GST certificate details, bank accounts, payment QRs, signatures or the dashboard logo. Those belong to the existing private workspace database.

First validate authentication and organization separation using a fresh database. To test the existing company setup, transfer a consistent backup privately to the persistent disk **after** HTTPS and access protection have been verified. Preserve a separate backup of the original workspace. Do not upload `.data`, `.env`, backups or the supplied Word/images as public static assets. Do not replay the historical company import, which predates independent organization logos and Shri Sarraf’s separate legal/payment identity. Keep private certificates and payment assets out of the source archives.

Back up a running database with SQLite's online backup API, or stop the service and copy its entire data directory including any WAL/SHM files. Never replace a live database with an older copy during a redeploy. Keep the persistent disk across deployments and use a single instance; SQLite is not configured for multiple replicas.

Use `npm run db:backup` for the verified online snapshot workflow. Recovery uses `db:restore` into a new private filename, invalidates restored sessions/reset tokens and holds notifications. The recovered file stays offline until the operator reconciles the snapshot's missing period and uses `db:resume`. Do not use recovery acknowledgement as a shortcut during routine deployment or run two workspaces with the same live merchant credentials.

A stateless/static-only host is not sufficient for saving invoices, customers or payments. A temporary disk can lose all edits on restart. Confirm persistent storage before entering business records.

## Separate provider settings

Shared `RAZORPAY_*` and Resend settings may serve the Venturecore divisions and workspace password resets. Shri Sarraf uses only its own `SHRI_SARRAF_CASHFREE_*` and `SHRI_SARRAF_EMAIL_FROM` / `SHRI_SARRAF_RESEND_API_KEY` / `SHRI_SARRAF_EMAIL_AUTOMATION` settings. Missing independent settings disable that business's integration even when the main company is configured. Do not copy another merchant's credentials just to make the configuration badge green.

Use Cashfree sandbox before enabling production. Permit the actual provider API hosts in the host's outbound policy: `api.razorpay.com`, `sandbox.cashfree.com` / `api.cashfree.com`, and `api.resend.com`. Webhook URLs and all prefixes are documented in [PLATFORM_SETUP.md](PLATFORM_SETUP.md). Support contacts in organization settings are Reply-To addresses, not automatically verified sending identities. Keys stay in hosting server settings; they are not included in deployment packages.

Sandbox GST lookup additionally uses `GST_PROVIDER=sandbox`, server-only `SANDBOX_API_KEY` / `SANDBOX_API_SECRET`, and `SANDBOX_ENVIRONMENT=test|production`. Permit `test-api.sandbox.co.in` and `api.sandbox.co.in` as needed. Use matching environment credentials. Test mode provides mock/example records only; production mode is required for real taxpayer details. Configure values securely on the host and restart; never bundle a credentials spreadsheet or `.env` in the source package. Verify an actual authenticated query before describing lookup as connected.

## Build an upload package

```bash
npm ci --include=dev
npm run package:preview
```

This builds and creates two archives with SHA-256 checksums:

- `release/venturecore-preview.tar.gz` contains application source, build and setup files for a Node service.
- `release/venturecore-hostinger-source.tar.gz` contains source only, without `dist`, for Hostinger's Node.js application deployment. Hostinger installs dependencies and builds on the host. Use the Node.js deployment option, not a static-site upload.

Both use an explicit list of application roots (`server`, `src`, `shared`, `scripts`) and setup/architecture/security documents, including hosted/preview launchers. Packaging rejects symlinks and private files accidentally added to source roots. It excludes business data, credentials, backups, Git metadata, tests and installed dependencies. These are runtime deployment archives; run the test suite from the complete development checkout. Install dependencies after extracting on a generic Node host. The private company backup is transferred separately, not bundled. Before deploying on Hostinger, confirm the actual plan supports Node 24.5+ and a persistent location for SQLite; account ownership alone does not establish those capabilities.

## Verify the hosted website

Run `npm run check:deployment` with the actual server settings before activation. It checks runtime, HTTPS origin, private database paths, admin provisioning and configured integrations without printing credentials. A passing local report does not establish that the host's disk survives redeploys or that real providers respond.

1. An unauthenticated visit must show the public home and Login/Signup; business API requests must return `401`. The unauthenticated health response must contain only availability.
2. Sign in as administrator over HTTPS and check the dashboard, division selector, logos and company settings; verify an approved staff account can see only assigned organizations. For a transferred database, verify the supplied company details privately.
3. In an isolated test database, create a customer and quotation, preview/print/download it, convert it to an invoice, add an installment plan and record a part payment. The same invoice must become Paid / Final after the balance is received.
4. Select Shri Sarraf and confirm its seller identity, GST, support address and gateway stay separate from Venturecore. Save test contacts in both businesses; each invoice picker must show only its own customers, B2B buyers and vendors. Test a named GST registration and inspect the saved invoice/PDF.
5. Configure only the main company email/gateway first and confirm Shri Sarraf remains unconfigured. Then add separate sandbox credentials, exercise the signed webhook and part/full-payment flow, and verify each email uses the correct sender and support address. These checks require the actual provider account and a verified sender; simulated local tests do not complete activation.
6. Open document edit, preview, payments/email and settings pages, refresh each saved-record page, and check browser Back/Forward on desktop and mobile. A copied page URL must resolve to the same organization/record only after authorized login. Confirm missing and unauthorized record URLs do not expose another business’s data.
7. Restart the service and confirm the test record remains. This verifies the actual persistent disk configuration.
8. Create and download a backup as administrator; verify staff/anonymous users cannot access it. Keep the manifest with the SQLite file, practice recovery into a separate private filename and verify the recovery hold before returning to normal operation.

GST portal access still requires outbound access to `services.gst.gov.in` and a successful human-entered CAPTCHA. It was blocked in the current cloud workspace; do not claim live lookup is verified merely because the website starts.
