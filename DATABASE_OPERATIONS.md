# Database storage, backup and recovery

The workspace uses SQLite on Node.js 24 or newer. All organizations share one database; records and staff access remain organization scoped. Shri Sarraf keeps its separate legal, GST, bank, gateway and email identity in that database. A backup is a copy of the entire workspace, not an organization export.

Use a persistent private disk for `DATABASE_PATH`. A container's temporary filesystem, a build directory and a public website directory are unsuitable. Database and backup paths must survive restarts and deployments, and must be readable only by the application account and authorized operators. Source packages and GitHub do not include the business database.

## Configure private storage

Set these server variables in the hosting environment. Paths below are examples; choose actual private directories supported by the host.

```dotenv
DATABASE_PATH=/srv/pirento-private/workspace.sqlite
DATABASE_BACKUP_DIR=/srv/pirento-private/backups
BACKUP_ENABLED=true
BACKUP_INTERVAL_MINUTES=1440
BACKUP_RETENTION_COUNT=7
```

Automatic backups are disabled unless `BACKUP_ENABLED=true` is configured. The default interval is 1,440 minutes and the default retention is seven snapshots. Retention is a snapshot count, not a guarantee of seven calendar days. Keep `DATABASE_BACKUP_DIR` absolute and outside public web roots and build output. Do not expose it through static routing or package it for deployment.

Confirm the host supports a persistent writable disk and Node.js 24 before importing company data. If the hosting plan does not provide these capabilities, the app needs suitable Node.js hosting or a VPS. A frontend-only static upload cannot run this SQLite backend.

## Take and validate a backup

Manual backups use Node's SQLite backup API to take a consistent snapshot, including committed transactions in the write-ahead log. They can run while the application is operating. Do not copy only a live `.sqlite` file with a file manager: recent transactions can still be in its WAL file.

Run from the project directory with the same private paths used by the service:

```bash
npm run db:backup -- --database /srv/pirento-private/workspace.sqlite --directory /srv/pirento-private/backups
```

Alternatively, configure `DATABASE_PATH` and `DATABASE_BACKUP_DIR` in the command environment and run `npm run db:backup`. Each snapshot directory contains `database.sqlite` and `manifest.json`; keep both files together. Backup operations check database integrity, foreign keys and the manifest checksum before treating the snapshot as usable. Keep the snapshot identifier reported by the command for restoration. A checksum detects file mismatch; it does not encrypt or authenticate the backup against someone who can replace both files. A successful local backup does not prove that another machine can recover it; practice restoration into a separate private destination.

Automatic snapshots use the same backup mechanism. Check backup results and disk capacity after deployment and after changes to the hosting filesystem. Retention cleanup applies to the backup directory; preserve any snapshot needed for an investigation or a migration separately before it reaches the retention limit.

The admin **Database backups** page creates snapshots and downloads their SQLite file and manifest separately. Keep both files; on a private server, place them as `database.sqlite` and `manifest.json` inside the directory named with their snapshot identifier before using the restore command. Staff and anonymous users cannot access the whole-workspace backup endpoints. The schedule and command must use a single backup writer per directory; do not run an independent cron writer against the same directory while the built-in worker is active. `db:backup -- --list` lists verified snapshots, and `db:backup -- --verify SNAPSHOT_ID` rechecks one.

Local snapshots protect against accidental edits and database corruption. They do not protect against loss of the hosting account, disk, server or backup directory. An encrypted off-site copy and its credentials, scheduling, monitoring and restore test must be configured separately. No automatic remote backup provider is configured by these settings.

## What a database snapshot contains

The snapshot includes customers, vendors, B2B buyers, organization settings, catalogs, business products, document templates, quotations, invoices, delivery notes, installment schedules, receipts, document numbering, history, accounts, organization access, gateway bookkeeping and the email outbox.

Uploaded logos, payment QR images, signatures and stamps are saved as image data inside organization, workspace, template, product and document records. Saved invoice snapshots retain their embedded branding. Those images are included in a consistent database snapshot.

The snapshot does **not** include server environment variables or API keys, `.env`, TLS configuration, source code, the built frontend, or the original private files under `.data/company-assets/` and `.data/workspace-assets/`. Preserve original company attachments and certificates separately when they are required. An HTTPS image URL remains a reference to another server; its remote image is not captured. Database backups themselves contain private financial and account information and must not be uploaded as public website assets.

## Restore into a new, private destination

Restoration deliberately creates a new database file. It refuses to overwrite an existing target. It does not switch the running service to that file or modify the current workspace. Keep the current database, its private source attachments and a fresh backup available until recovery is verified.

1. Identify the required snapshot and its age. Stop the application and background workers before recovery cutover. Ensure no other process is using the recovery target.
2. Restore into a new private filename. Set `DATABASE_BACKUP_DIR` or pass the backup directory explicitly. Replace `SNAPSHOT_ID` with the identifier reported by the backup command:

   ```bash
   npm run db:restore -- --backup SNAPSHOT_ID --directory /srv/pirento-private/backups --target /srv/pirento-private/recovered/workspace.sqlite
   ```

3. Keep the recovered database offline while reviewing everything that happened after the snapshot. The restore command places a pending recovery marker in `ops_recovery_state`. The normal server refuses to start against that database before HTTP serving, payment handling and email workers begin.
4. Complete the reconciliation described below. Do not run the original and recovered workspaces simultaneously with the same live gateway credentials, email automation and customer-facing identity.
5. With all processes using the recovered database still stopped, acknowledge completed reconciliation:

   ```bash
   npm run db:resume -- --database /srv/pirento-private/recovered/workspace.sqlite --acknowledge-reconciliation
   ```

6. Point the service's `DATABASE_PATH` to the reviewed recovered database, confirm the private storage and environment settings, and restart. Verify HTTPS, admin login, organization access, document totals and held-message handling before returning to normal use.

The acknowledgement records an operator decision. It does not contact payment or email providers, recover missing records, verify the review, or prove that the restored snapshot is current. Do not acknowledge it merely to bypass the startup block.

## Reconcile before resuming

**Accounts and access:** restoration revokes all saved sessions and password-reset tokens. Users must log in again, and pending reset emails are invalidated. The restored account records may still contain older passwords, active accounts that were later disabled, or wider organization access than is currently allowed. Compare administrator/staff roles, approvals and organization permissions against the current pre-restore records and correct them before allowing access.

**Invoices and receipts:** compare the snapshot with the preserved pre-restore database and issued documents. Review documents, customer changes, offline receipts, installment payments and invoice numbers created after the backup. An older snapshot can have older numbering counters. Preserve and reconcile issued invoice numbers and accounting history; do not recreate missing receipts with guessed amounts or allow a previously issued number to be used again. The restore operation retains saved financial records, numbering and finalization state without inventing transactions.

**Razorpay and Cashfree:** check the correct provider account and environment for each organization. Review payment links and payments created after the snapshot, captures or failures on existing links, cancellations, expiries and any unconfirmed link creation. Compare provider payment IDs, amounts and currencies with the ledger, and retain the original idempotency and webhook records. Existing Sync actions reconcile saved nonterminal links; they cannot discover every link or invoice absent from the snapshot. Do not create a replacement link for an uncertain provider request or mark a balance as paid without verified evidence. Shri Sarraf must be reviewed against its own Cashfree account.

**Email:** restore holds queued or in-progress invoice/payment emails and preserves their attempt and delivery history. Check the correct sender account's provider delivery logs before retrying or creating a replacement message. A message shown as unsent in an old snapshot may have been delivered later. Provider idempotency protection has a finite lifetime; the app's normal retry window is 23 hours after the first attempt. Restoring an earlier snapshot can also lose the first-attempt timestamp, so a held status or Retry button does not establish that sending is safe. Do not release held financial emails until the corresponding invoice balance and payment link are current. Request a new password reset after recovery instead of resending an invalidated reset link.

**Business settings and integrations:** review current legal names, GST registrations, bank details, QR images, support addresses and gateway/email profiles against the recovered settings. Restore server secrets separately through secure hosting settings. The database snapshot cannot supply them. Confirm matching test/production environments before any real GST lookup, payment operation or email delivery.

## Deployment checks

Use `npm run check:deployment` to review the server's deployment configuration. This does not replace provider authentication, webhook delivery, email delivery, persistent-disk verification or a restore practice run. Perform those checks on the actual HTTPS host using approved test accounts before enabling real transactions.

Keep backups private during migration. Transfer them through an authenticated private channel, preserve a copy at the original location, restore into a new destination, and complete the recovery review before startup. Source deployment archives exclude `.data`, environment files, backups and user-supplied originals; uploading an archive alone does not migrate business data.
