# MongoDB migration, backup and recovery

## What changed

The runtime database is now MongoDB. `.example.env` is loaded directly, so the old `.env` and `DATABASE_PATH` settings are not used. The source project did not include a live customer database. A first launch therefore creates the original organization/product/format defaults in the configured MongoDB database; it does not reconstruct unprovided business records.

An existing original **schema-v5 SQLite** workspace can be imported with the command below. Earlier SQLite schema versions must first be upgraded using the original application and backed up. The importer refuses unknown versions instead of guessing how financial history should be transformed.

For an existing MongoDB workspace, Phase 4 is a **coordinated source upgrade**, not a new SQLite import. Stop every v2.3 or older application/worker process, preserve the database and private configuration, then start all replacements on 2.4.0. The new 32-stripe transaction protocol must not run alongside older writers that only acquire the old global coordination row. See [Phase 4 upgrade notes](PHASE-4.md) and [Deployment](DEPLOYMENT.md).

| Original storage                                        | MongoDB destination                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| JSON business records in SQLite `data` columns          | Native objects with the same application IDs in the corresponding collection.              |
| Saved issuer/customer/product/format/branding snapshots | Embedded native objects on the same historical document.                                   |
| Document counters                                       | Native `sequences` records with the same organization/kind/year values.                    |
| Receipts, void records, document events                 | Separate native ledger and event records with original references.                         |
| Authentication organization-ID JSON and audit JSON      | Native arrays and objects. Existing password hashes are retained.                          |
| Email payload JSON                                      | Native objects; queued/sending messages are placed on hold.                                |
| Online gateway tables                                   | Provider links, references, verification and webhook history in corresponding collections. |
| Active sessions and reset links                         | Invalidated during import/restore; users sign in again and request fresh reset links.      |

Imports preserve source row order when allocating new MongoDB `_id` values, keeping the application's insertion-order behavior. Original application IDs, document numbers, amounts and business references are preserved. MongoDB uniqueness constraints can reject an inconsistent source; there is no merge or overwrite mode.

## Before importing

1. Stop writes to the original application and keep its original deployment available for rollback.
2. Create and verify a SQLite backup with the original application's backup command. Use that stable backup as the source. Copying only a live `.sqlite` file can omit WAL transactions; use the original backup procedure or stop the old server and preserve the complete database set.
3. Configure `MONGODB_URI` for the destination replica set in `.example.env` or the process environment. Choose a **new empty** destination name, such as `venturecore_import_review`.
4. Keep the new application stopped while importing and reviewing the result. Disable automatic emails and avoid processing the same provider callbacks through old and new applications at once.

The source is opened read-only, checked for SQLite integrity/foreign-key consistency and validated against the supported schema. The destination is checked for existing records before initialization. Insertions and the recovery hold are committed together in one transaction; a conflict does not partially import business records. Creating empty collections/indexes before that transaction can leave empty schema objects after a failed import, which can be inspected and safely retried with an empty destination.

## Import the original SQLite workspace

From this project directory, using the absolute path of a stable backup:

```bash
npm run db:import-sqlite -- --source=/private/migration/workspace.sqlite --database=venturecore_import_review --confirm-import
```

The command reports the destination and imported collection counts. It does not print customer records, password hashes or credentials, and it does not change the active `MONGODB_DATABASE` setting for you.

For paths containing spaces, quote the whole option, for example `"--source=/private/migration/old workspace.sqlite"`. On Windows use the corresponding absolute path; Linux/WSL is the verified platform for private snapshot permissions.

Import places the destination on a **recovery hold**. Starting the application with that database will stop with a recovery-review message until the review below is acknowledged. The source database remains unchanged.

## Review and cut over

Using your database administration tools and retained original reports, compare organization/contact/document counts, the most recent numbers, invoice totals, received amounts, voids, outstanding balances and active staff access. Reconcile any payment provider activity and email delivery since the source backup was taken. Do not treat an acknowledgement command as bank/provider verification.

The recovery step clears sessions and password-reset tokens, holds queued/sending emails and invalidates unsent password-reset payloads. Sent email/provider history is retained. Active or uncertain online payment links require particular care: a restore does not cancel a live provider link or refund money outside the database.

In Phase 3 snapshots, recovery also disables every reminder policy and pauses every unfinished recurring invoice schedule, incrementing their revisions. It clears email claim ownership. Generated occurrence records, next dates, draft references, completed schedules and audit history remain intact. A Phase 1/2 snapshot without these new collections still restores; application startup creates the new empty collections and indexes.

After completing that review:

```bash
npm run db:resume -- --database=venturecore_import_review --acknowledge-reconciled
```

`--acknowledge-reconciliation` is accepted as a compatibility alias. Both flags mean the operator has already performed the review. The command releases the startup hold; held emails remain held for individual review/retry.

The command does not reactivate recurring schedules or reminder policies. After signing in, review each schedule's next date, backlog and generated invoices before selecting **Resume**. Resume can create past-due drafts in bounded passes using their original scheduled dates. Review per-business sender settings and timing before enabling **Automatic reminders**; only current/future matching rule dates are queued. Old unattempted reminders held by a changed/restored policy remain held. Review already attempted messages against provider history before retrying them.

Set `MONGODB_DATABASE=venturecore_import_review`, start the application, and verify login and representative documents. Imported existing passwords still work, but old sessions do not. Check business-specific gateways and sender settings before enabling workers. Switch traffic/webhooks once so two independent workspaces do not accept the same business activity.

Keep the old system stopped and retained for rollback. After new transactions occur in MongoDB, pointing traffic back to an older SQLite backup would lose those new records unless they are reconciled separately.

## Create a MongoDB backup

The administrator **Database backups** page and CLI use the same backup service. Backups include all workspace collections and index definitions in a consistent transaction snapshot. BSON values are encoded as canonical Extended JSON, including IDs and dates. A separate manifest records format version, size and SHA-256.

```bash
npm run db:backup -- --directory=/private/venturecore-backups
npm run db:backup -- --list --directory=/private/venturecore-backups
npm run db:backup -- --verify=SNAPSHOT_ID --directory=/private/venturecore-backups
```

Replace `SNAPSHOT_ID` with an ID returned by create/list. The command returns the exact snapshot and manifest paths. Optional `--database=NAME` selects a database without editing `MONGODB_DATABASE`. If no directory option is provided, `DATABASE_BACKUP_DIR` is used, with the private local default when unset.

Each snapshot directory contains:

| File             | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `database.ejson` | Native MongoDB collections, documents and index definitions. |
| `manifest.json`  | Snapshot identity/version, byte count and checksum.          |

Download and retain **both files** when using the UI. Restoring a SQLite backup with the MongoDB restore command is not supported; use the SQLite importer for that format.

Set `BACKUP_ENABLED=true` to run the configured schedule while the server is active. `BACKUP_INTERVAL_MINUTES` accepts 1–10080 and `BACKUP_RETENTION_COUNT` accepts 1–365. A verified snapshot is created before retention cleanup. Keep one backup writer per directory. File permissions, symlink checks and checksums protect local snapshot handling; they do not replace an offsite copy or a recovery rehearsal.

The portable snapshot service loads the workspace snapshot into memory during validation/export/import. It targets this application's workspace size and is not a streaming backup system for arbitrarily large clusters. For significantly larger datasets, plan a tested MongoDB-native operational backup strategy alongside application recovery reconciliation.

## Restore a MongoDB snapshot

Stop the application for cutover and choose a new empty destination. Keep the source EJSON and manifest in a private directory. On POSIX systems use permission `600` for files and `700` for the containing directory.

```bash
npm run db:restore -- --file=/private/restore/database.ejson --manifest=/private/restore/manifest.json --database=venturecore_restore_review
```

The complete source size, checksum, identity, format version and BSON structure are checked before writing to MongoDB. The target must be empty. Business records and compatible indexes are inserted without upserts; duplicate/conflicting records abort the import transaction. A restored backup of a database already on hold is still held for a fresh review.

Phase 4 permits only the exact pre-created coordination protocol rows when checking an otherwise empty destination: the original workspace row and 32 fixed stripe rows, with only `_id` and a valid nonnegative revision. Unknown coordination IDs, additional fields and occupied business collections still cause refusal. Source coordination rows are skipped on import; the destination uses its own initialized rows. This also allows older snapshots with the single original coordination row to restore through the same controlled workflow.

The new `auth_rate_limits` collection is included in snapshots. Its counters are temporary: original expiry timestamps are retained, and the limiter rechecks them using the database clock. Restore still invalidates all sessions/reset links and retains security audit history. It does not activate reminder policies, resume unfinished recurring schedules or release uncertain email.

Perform the same account, document-number, payment and email reconciliation described above, then release the hold:

```bash
npm run db:resume -- --database=venturecore_restore_review --acknowledge-reconciled
```

Only then select this database in `MONGODB_DATABASE` and restart the app. Recovery does not rewrite external provider history, automatically send held messages or erase the original source database.

## Troubleshooting

| Message/symptom                           | Action                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Replica set required                      | Use the included one-node development replica set, Atlas or another transaction-capable replica/sharded deployment.                          |
| Destination is not empty                  | Choose a new name. Do not drop or merge the active business database to make a command pass.                                                 |
| Unsupported SQLite schema                 | Upgrade and back up with the matching original application first; the importer accepts schema v5.                                            |
| Checksum/size/manifest mismatch           | Retrieve both files from the same verified snapshot; do not hand-edit the manifest.                                                          |
| Private permissions rejected              | Move files outside public assets and use private file/directory permissions on Linux/WSL.                                                    |
| Startup held for recovery review          | Complete reconciliation, then run `db:resume` for that exact database.                                                                       |
| Emails remain held after resume           | Review each delivery against provider history before using the existing retry action.                                                        |
| Reminder automation remains off           | Open Payment reminders for the business and save a reviewed enabled policy; the global recovery command does not enable it.                  |
| Recurring schedules remain paused         | Review next dates, backlog and generated history, then Resume each unfinished schedule explicitly. Completed schedules stay completed.       |
| Import rejected by uniqueness constraints | Resolve duplicate source IDs, numbers, SKU/product codes or other reported source consistency problems before retrying into an empty target. |

Run either command with `--help` for the exact supported options. No destructive overwrite, arbitrary collection deletion or automatic production cutover option is provided.
