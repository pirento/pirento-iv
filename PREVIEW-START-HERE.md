# Disposable synthetic preview

This is an optional testing mode for the invoice system. Use invented customers, invoices and manual payment records. **Every process start creates a new database and test administrator.** A restart or redeploy does not reopen previous test work. Old run directories are not automatically deleted. No real company records, original logos/signatures, bank details or credentials are bundled.

For the permanent business system, follow [PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md) and use persistent private storage. Do not migrate real records into this disposable mode.

## Build the separate upload

Use Node.js **24.5 or newer**, npm, `tar` and `zip`:

Run these build/test commands from the complete [Git repository](https://github.com/pirento/pirento-iv), which includes `tests/`. The upload ZIP is a runtime deployment artifact; its `npm test` deliberately reports the omitted tests and points to the full repository rather than claiming a passing run.

```bash
npm ci --include=dev
npm test
npm run package:synthetic-preview
```

Generated files in `release/`, each with a SHA-256 checksum:

- `venturecore-disposable-synthetic-hostinger-source.zip`: source upload for a host-side build.
- `venturecore-disposable-synthetic-hostinger-source.tar.gz`: the same source in tar format.
- `venturecore-disposable-synthetic-preview.tar.gz`: source plus compiled frontend.

Only these disposable artifacts set `npm start` to the synthetic launcher. The Git checkout and ordinary `package:preview` archives keep their persistent-server startup. Deployment archives omit development tests; run them from the Git checkout.

## Hostinger Node application settings

| Setting                       | Value                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Runtime                       | Node.js 24.x, at least 24.5                                                       |
| Project root                  | Archive root                                                                      |
| Install                       | `npm ci --include=dev`                                                            |
| Build                         | `npm run build`                                                                   |
| Entry file, when requested    | `hostinger-entry.mjs`                                                             |
| Start command, when requested | `npm start` in the disposable archive; `npm run start:synthetic-preview` from Git |
| Output directory              | Blank; Express serves frontend and API                                            |
| Port                          | Provider-supplied `PORT`                                                          |

Set these nonsecret values in the hosting environment:

```text
NODE_ENV=production
IV_PREVIEW_MODE=disposable-synthetic
PUBLIC_APP_URL=<exact HTTPS origin assigned to this preview, no trailing slash>
HOST=0.0.0.0
```

Enter **preview-only** `IV_PREVIEW_ADMIN_EMAIL` and a unique `IV_PREVIEW_ADMIN_PASSWORD` of 12–256 characters through the host's secure environment settings. `IV_PREVIEW_ADMIN_NAME` is optional. Keep these values configured for later fresh starts. Do not reuse production passwords or production `INITIAL_ADMIN_*` values. Public signup still requires administrator approval and organization assignments.

If the host uses a reverse proxy, set optional `TRUSTED_PROXY` to its actual IP addresses/CIDRs, comma separated. The default ignores forwarded IP headers. Never use `true`, a hop count or a universal range. The ingress must replace client-supplied forwarded headers and keep the backend port inaccessible to other clients. Login limits use normalized email plus resolved client IP; successful logins do not exhaust the failed-attempt limits.

Remove inherited database, payment, GST, email, broker and cloud credentials, `DATABASE_PATH`, `DATABASE_BACKUP_DIR`, `IV_ALLOW_NEW_DATABASE`, and production `INITIAL_ADMIN_*` settings from the preview app. Never upload `.env`, business databases, original assets or private backups. The launcher refuses private dotenv files and integration/database settings, then passes only sanitized preview settings to the application.

## Boundaries and checks

- Private `.preview-data/run-*` directories and new SQLite files are created exclusively; existing runs are never reopened. The launcher and application factory independently reject linked or unsafe storage paths.
- Login and every application page carry a persistent warning. Seeded seller names and numbering are labeled TEST. Downloaded PDFs and every browser-printed page carry a TEST watermark.
- GST lookup, payment-link operations, webhooks, email sending/retry and password-email/reset routes are disabled. Manual payment and installment testing remains available.
- No mail worker or automatic backup scheduler runs. Injected application transports and process client fetch/HTTP/TCP/TLS/UDP entry points reject outbound requests. This protects the trusted app; it is not an operating-system sandbox for arbitrary code.
- Browser CSP restricts connections/assets to this origin and local image/PDF processing. External, executable and credential-bearing links are blocked; same-origin blob PDF downloads remain available.
- Authentication, assigned organization access and administrator-only backup actions remain enforced. Optional manual backups contain only the current synthetic run; they provide no hosted persistence guarantee.

After deployment, verify the actual HTTPS health page, owner login, mobile navigation, quotation-to-invoice flow, partial/final payments, PDF/print labels and disabled integrations. Confirm restart creates a fresh run in this **test app only**. Software cannot determine whether typed data is real, so use invented records.

This package creates no hosting resource and proves no public URL. Hostinger deployment, secure test-admin configuration and hosted acceptance must be completed before reporting a working testing link. Permanent database durability and live provider activation require separate verification.
