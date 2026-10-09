# Security and deployment boundaries

This document describes implemented controls and operational requirements. Passing tests or a dependency audit does not certify a deployment, a payment account or email delivery. Hostinger/public deployment and live-provider activation require their own checks in [PLATFORM_SETUP.md](PLATFORM_SETUP.md) and [PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md).

## Accounts and access

- Public signup creates a pending request. An administrator must approve the person and assign organizations before staff can access business records. The first public signup is never promoted automatically.
- Passwords use individually salted asynchronous scrypt. Sessions are random tokens whose hashes are stored in SQLite; cookies use HttpOnly, SameSite and Secure in production, with a 12-hour session lifetime.
- Production startup requires the exact HTTPS application origin. JSON mutation requests are checked against that origin and cross-site request metadata. Account endpoints have bounded request-rate buckets. Proxy forwarding headers are not trusted to change the apparent client identity.
- The backend checks staff permissions against both submitted organization IDs and the stored resource's organization. Admin-only changes remain server-enforced; editing a page URL or calling an API directly cannot grant an assignment.
- Disabling a user or changing access revokes sessions. Password-reset links expire after 30 minutes, are single-use and reset sessions. Tokens stay out of ordinary delivery history. Reset tokens belong in the URL fragment, not query strings sent to the web server.
- Account login is the active access system. The unused shared preview-password implementation has been removed.

The initial owner is provisioned with server-only startup settings. Remove both bootstrap email and password after the owner successfully signs in. Never put account passwords, session tokens or integration secrets into frontend code, `VITE_` variables, logs, source archives or chat.

## Business and payment isolation

Organization data, GST registrations, contact roles and saved document snapshots are validated on the server. Shri Sarraf is an independent business: its Cashfree/email settings never inherit Venturecore credentials. Defining part of a prefixed credential group disables fallback for the entire group, preventing mixed sender/key or account/secret combinations.

Gateway webhook routes are intentionally public. They verify a signature over the original raw body using the corresponding merchant secret, then independently fetch and validate provider records before crediting a receipt. Browser return URLs and webhook claims alone do not mark invoices paid. Provider events and payment IDs are scoped/deduplicated, and receipt/notification changes are transactional. Amount/currency/link mismatches remain review states rather than automatic credits.

Active or unresolved payment links block competing financial edits and offline receipts. Fully paid invoices retain their number and lock editing. Verified gateway receipts cannot be manually voided. Refunds, chargebacks and accounting filing require separate reconciliation; the application does not represent them as local receipt corrections.

Email queues retain the issuing organization, saved recipient and support identity. Sender, attachment, request body and credential fingerprint are fixed for retries; keys are not stored in the payload. A different credential profile or an ambiguous attempt outside the safe provider retry window requires review before another send. Support/Reply-To addresses are not automatically verified outgoing senders.

## Requests, images and external services

The service uses parameterized database values and strict input validation. Responses do not expose raw provider credentials, database paths or stack traces. Anti-framing, MIME-sniffing and referrer response headers are set; production also applies a Content Security Policy and HTTPS transport policy. Authenticated API responses are not cached. Repeated organization/document query parameters are rejected instead of bypassing scope checks. Account bodies have a smaller limit than invoice requests, and provider JSON responses are size-bounded. Uploaded branding accepts supported raster formats; email PDF rendering checks decoded image dimensions before handing them to the PDF generator. Server-side PDF generation does not fetch arbitrary image URLs.

GST portal lookups require a human-entered CAPTCHA. Challenges expire and are single-use. No CAPTCHA bypass is implemented, and failed provider access never fabricates taxpayer data. Configured gateway/GST/email endpoints must be reachable through the host's outbound network policy; do not disable TLS verification or bypass the proxy to work around a blocked host.

## Persistence and deployment

Use one Node.js 24.5+ service behind HTTPS with a persistent SQLite location. Keep the internal HTTP listener private. A stateless host or separate SQLite copies across replicas can lose or split records. A reverse proxy may share an account rate-limit bucket because the app uses the trusted socket peer; tune the hosting design deliberately before a large rollout.

The database contains customer records, business payment details, account hashes and documents. Protect the disk and backups with hosting access controls and appropriate storage encryption. The application does not implement its own encryption at rest or automatic offsite backups. Verified local snapshots use SQLite's online backup API, private folders/files, checksums, integrity and foreign-key checks. A checksum does not authenticate a backup against someone able to replace both its database and manifest. All backup APIs, including downloads, require administrator access and return no-store responses; they contain the whole workspace, not only the current organization. Unknown or unsafe snapshots are not deleted by retention.

Offline recovery only creates a new target; it never overwrites the live database. It revokes saved sessions/password-reset tokens, invalidates pending reset emails and holds queued/in-progress financial notifications. A persisted recovery marker blocks server startup before HTTP/providers/workers run until operator acknowledgement. Review restored staff access, invoice sequences and payment/email activity after the snapshot; acknowledgement does not reconstruct missing activity or establish a current ledger. See [DATABASE_OPERATIONS.md](DATABASE_OPERATIONS.md). Original certificates/files and secrets require separate private protection. If copying the data directory without the online API, stop the service and include its WAL/SHM files.

Source packages use an explicit allowlist and exclude `.data`, `.env`, private uploads, backups, Git metadata, dependencies and tests. Uploaded GST certificates, original QR/signature files and company import data must never be placed under public `dist` assets. A GST-certificate verification QR is not a payment QR.

The optional [disposable synthetic preview](PREVIEW-START-HERE.md) refuses private environment files and database/integration settings, creates a fresh isolated database on every start and disables external service routes, workers and injected transports. Its application factory rechecks private, unlinked storage and refuses existing files. Its stricter browser CSP, navigation guard and repeating print/PDF TEST labels do not substitute for backend access checks. The process network lock protects trusted application client entry points; it is not an OS sandbox. Do not enter real business data into this mode or treat its manual backups as verified hosted persistence.

## Maintaining the code

Use the supplied lockfile with `npm ci`. Run `npm audit` when dependencies change and review the actual advisories before choosing upgrades; do not blindly apply breaking fixes. Automated tests cover auth, organization isolation, financial rules and simulated provider boundaries. Browser checks use a separate database and synthetic customers/payments; they must not mutate business data or send external messages.

The dependency audit performed on 8 October 2026 reported zero known advisories for the then-current lockfile. That is a point-in-time package check, not a promise that the application has no vulnerabilities. Review dependency changes and re-run relevant checks before deployment.

If an issue is suspected, notify the workspace administrator privately with affected behavior and reproduction steps. Do not include live credentials, customer data or usable reset/session tokens in a public issue. Revoke compromised sessions/keys and review provider and application records before replaying financial or email operations.
