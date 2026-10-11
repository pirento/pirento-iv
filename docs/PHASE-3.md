# Phase 3 — customer ledgers, reminders and recurring drafts

Release: **2.3.0**. This release adds three connected receivables workflows to the complete EJS, JavaScript, Express MVC and native MongoDB application. It includes the [Phase 1 correctness fixes](PHASE-1.md) and [Phase 2 performance, worker and operational changes](PHASE-2.md).

The new **Receivables** navigation contains Customer ledger, Payment reminders and Recurring invoices. Each screen uses the selected business and the signed-in account's organization access. Existing invoice calculations, document kinds, receipts, financial locks, saved snapshots, payment gateways and document-email workflows remain available.

## Changes at a glance

| Feature            | What it provides                                                                                                                            | Default and access                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer ledger    | Searchable customer balances, dated invoice/receipt/void statements, complete matching CSV and a printable statement.                       | Read-only. Administrators and staff with access to the selected business can use it.                                                           |
| Payment reminders  | A preview and explicit manual queue action, optional automatic timing around unpaid invoice/installment dates, and delivery history.        | Automatic reminders start **off** for every business. Authorized staff can preview/queue; only administrators can change the automatic policy. |
| Recurring invoices | Explicit schedules that create separate invoice drafts, with pending dates, pause/resume, retry protection and occurrence/activity history. | New schedules default to **paused**. Administrators manage/generate; authorized staff can inspect schedules and history.                       |

No new environment variables or provider credentials are introduced. `.example.env` continues to load directly. Reminder delivery uses the existing configured sender for its business; recurring draft generation does not require a payment or email provider.

## 1. Customer ledger

### Using balances, statements and exports

Open **Receivables → Customer ledger**. Search by saved customer name, email, phone, GSTIN or ID, then choose Active/Archived and All/Outstanding/Overdue filters. Search is literal and restricted to the selected business. The list defaults to 50 customers per page, and the four amount cards cover **all matching customer accounts**, including those on later pages.

Choose **Open statement** for a customer. From date and Through date are inclusive; blank bounds include all recorded dates on that side. Valid filter dates use `YYYY-MM-DD`, from 2000 through 2199. A date range changes the statement movements and opening/closing balances. The footer's current outstanding and overdue amounts continue to cover all currently issued invoices for that customer.

**Export all matches** and **Export statement** include the complete selected result, independently of pagination. **Print statement** opens all selected rows in a separate printable view; **Print / Save PDF** uses the browser's print dialog. Entered filters are carried into export and print, including changes not yet submitted with Apply. The export contains INR amounts with exact two-decimal formatting, escaped CSV cells and protection against formula-like text. Numeric credit balances remain numeric negative values.

Page examples:

```text
/workspace/ORGANIZATION_ID/ledger?q=ACME&balance=outstanding
/workspace/ORGANIZATION_ID/ledger?active=archived&download=csv
/workspace/ORGANIZATION_ID/ledger/preview/CUSTOMER_ID?from=2026-04-01&to=2026-06-30
/workspace/ORGANIZATION_ID/ledger/preview/CUSTOMER_ID?from=2026-04-01&to=2026-06-30&print=1
```

### Financial scope and customer identity

The ledger is a read view over the existing invoice snapshots, payments and activity records. It does not create another financial journal or change source balances.

Only invoices currently saved as `sent`, `partially_paid` or `paid` contribute to receivables. Quotations, proformas and delivery challans do not contribute. Unissued drafts, cancelled invoices and unsupported invoice statuses are excluded; a customer statement lists its excluded invoices separately with links. If an excluded invoice has receipt history, its invoice and receipt movements are excluded together, with an explanation. The ledger does not infer a refund or backdate a cancellation.

Current invoiced, received and outstanding amounts preserve the existing shared financial calculations, including legacy `paid` status and saved paid/balance fallbacks. Overdue uses the current Indian business date and the same oldest-due-first installment allocation as the invoice/payment screens. A due date equal to today is due today, rather than overdue.

Accounts are associated only through the saved `document.customerId` inside the selected organization:

- Archived contacts remain available by default, and two contacts with the same name remain separate accounts.
- If a nonempty saved customer ID has no contact record, its account is still shown with a **Saved customer reference** notice and the latest matching invoice's customer snapshot.
- Invoices without a usable customer ID appear as a separate organization-level unlinked summary. Matching names or `customerSnapshot.id` values do not silently associate them with a contact. No synthetic customer ID or statement route is invented for this group.

The unlinked summary sits outside filtered customer totals. An entirely unfiltered customer CSV includes its separately labelled organization summary row; a filtered customer CSV contains only the matching customer accounts. The UI also provides a few source-invoice links for reviewing unlinked records.

### A statement's date basis

Every statement permanently identifies its basis as **current invoice status**. The existing data does not record complete dated issuance and cancellation transitions. A statement therefore shows today's selected invoice set using its saved transaction dates; it is **not a historical as-of account** that can reconstruct the invoice statuses that existed on an earlier day. A later cancellation can change a statement rerun for the same earlier period.

The dated rows use these sources:

| Entry            | Date and amount                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice`        | Saved valid issue date; debit for the invoice total.                                                                                              |
| `receipt`        | Saved valid `paidOn`, or the original `providerPaidAt` converted to Asia/Kolkata when `paidOn` is missing/invalid; credit for the receipt amount. |
| `receipt_void`   | Saved valid void timestamp converted to Asia/Kolkata; debit reversing that receipt.                                                               |
| `legacy_balance` | An explicitly undated saved-balance difference. It explains the current snapshot without claiming a payment occurred on an invented date.         |

A receipt's creation time is not substituted for a missing payment date. Free-text activity descriptions are not parsed to invent financial amounts or dates. Activity counts can identify missing receipt/void records and flag incomplete history.

For complete dated records, the statement calculates the opening balance from rows before From date, then applies all movements in the selected window before pagination:

```text
opening balance + period debits − period credits = closing balance
period net receipts = period receipts − period receipt voids
```

This also preserves a valid negative credit balance when a recorded payment predates its invoice issue date. A later page's running balance includes earlier pages' movements.

Legacy paid invoices without receipt rows retain their current received and outstanding values. Missing/invalid source dates, undated differences, missing receipt history, inconsistent saved amounts or a void predating its receipt produce explicit notices. In these cases `history.complete` is false, formal opening/closing/running balances are `null`, and the UI displays **Not available**. Undated rows remain visible under every date filter. The API's `known…Paise` fields describe only the dated rows that can be calculated; they do not certify the missing history. Even when `history.complete` is true, the permanent current-status limitation still applies.

### Ledger API contract

All endpoints require an authorized `organizationId` query parameter. The service also checks account/organization access itself, including exports and an individual customer lookup. A customer ID belonging only to another business cannot be used to obtain its statement.

| Method and endpoint                  | Query and result                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ledger`                    | `q`, `active` (all, active, archived), `balance` (all, outstanding, overdue), `page`, `pageSize`. Returns `customers`, all-matching `totals`, `unlinked`, `notices`, filters and pagination. |
| `GET /api/ledger/export`             | Same customer filters; downloads all matching customer balances as CSV.                                                                                                                      |
| `GET /api/ledger/:customerId`        | `from`, `to`, `page`, `pageSize`. Returns the customer, `rows`, current `summary`, selected `period`, `history`, `excludedDocuments` and pagination.                                         |
| `GET /api/ledger/:customerId/export` | Same date filters; downloads the complete statement, with opening/closing entries, current totals, notices and excluded invoices.                                                            |

`q` is limited to 200 characters. Pages are positive integer query strings; `pageSize` defaults to 50 and accepts 1–100. Pages beyond the result count are clamped. Empty results remain valid. Invalid dates, reversed date ranges, repeated/non-scalar filter values and invalid page sizes are rejected.

Ledger money fields are safe integer **paise**. For example, `12345` means INR 123.45. Customer/current-summary fields include `invoiceCount`, `invoicedPaise`, `receivedPaise`, `outstandingPaise`, `overduePaise`, `overdueInvoiceCount` and `unreceiptedCreditPaise`. The latter is the signed difference between saved paid amounts and active receipt records, not a new receipt.

Each row includes `type`, `date`, document/payment identifiers, `reference`, `description`, `debitPaise`, `creditPaise`, `balancePaise`, `knownBalancePaise` and a scoped document `href`. `period` includes opening/closing, invoiced/received/voided, debit/credit and known-balance fields. `history.basis` is always `current_invoice_status`. The service computes the full period before returning a page, so page size cannot change totals.

Implementation: [ledger service](../src/services/ledger/customer-ledger.js), [statement calculations](../src/services/ledger/ledger-statement.js), [read queries](../src/models/customer-ledger-queries.js) and [controller](../src/controllers/api/ledger.controller.js).

## 2. Payment reminders

### Preview and queue a manual reminder

Open **Receivables → Payment reminders**. The dashboard shows unpaid invoice or installment dates with Overdue, Due today and Upcoming filters. A target requires a currently issued `sent` or `partially_paid` invoice, positive remaining balance and a valid due date. An installment plan uses the same allocation as the payment view; fully covered installments do not become reminder targets.

Use **Preview reminder** to review the invoice, saved recipient, subject, due date and remaining amount. **Queue reminder** creates an outbox entry after checking the target again. Missing recipient email or business sender configuration appears as an unavailable reason. Changing only the current contact record does not silently redirect an existing invoice's saved recipient.

The message includes the target balance, invoice balance, due date, the invoice's payment instructions and an invoice PDF. Reminders do not create or attach a gateway payment link and do not perform a gateway operation. Queueing reports acceptance into the local outbox; provider acceptance and failures appear in **Reminder history** and the invoice's email page.

Repeated manual requests for the same organization, invoice, installment, due date and Indian business day return the **same outbox message** with `duplicate: true`. They do not implicitly retry a failed/held delivery. A request on another Indian business day is a separate manual occurrence. A due date changed after preview causes a conflict instead of queueing the obsolete target.

### Explicit automatic policy

An administrator can open **Automatic reminders**, choose timing, enable the checkbox and select **Save reminder settings**. Every business starts with automation off, even if the existing `EMAIL_AUTOMATION` setting is enabled. Conversely, an explicitly enabled reminder policy can work when that legacy flag is false. The two settings control different workflows.

| Policy or scheduler setting | Behavior                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial policy              | Disabled, revision 0, suggested offsets `[-3, 0, 3, 7]`.                                                                                   |
| Offset values               | 1–12 unique whole-day offsets, from 30 days before through 90 days after the due date; saved in sorted order.                              |
| Enabling requirements       | Existing configured sender for that business and the current policy `version`.                                                             |
| Effective date              | Enabling or meaningfully editing an enabled policy sets its effective date to today's Indian business date.                                |
| Automatic matching          | Queues only when `dueDate + offset` equals today's Indian business date and the current target is eligible.                                |
| Default queue limit         | Up to 100 newly queued automatic messages per service pass. The internal service accepts limits 1–500; this is not an environment setting. |

**Missed automatic reminder dates are not caught up after downtime.** An already queued message may still be delivered on a later day if it remains eligible, using refreshed wording and amounts before its first attempt. These are different cases: the scheduler does not create a new backlog of missed calendar events.

An automatic event is identified by organization, invoice, installment, due date and offset. Its identity does not include policy revision, so editing/re-enabling the policy cannot duplicate that rule/date event. Enqueue checks, policy revision, current invoice state and the unique outbox event key are protected by the existing shared write transaction.

A meaningful policy edit increments its revision and immediately holds unattempted automatic reminders, revoking their claims. Same-value saves are a no-op after checking the version. Old automatic rows remain held/deduplicated after re-enabling. Manual reminders and deliveries already attempted are unaffected by policy changes.

### Delivery freshness and the retry boundary

Before the first provider transport, the worker checks the latest balance, installment allocation, cancellation, due date, automatic policy, recipient and sender. It refreshes an unattempted reminder's payload and PDF. If the invoice changes during PDF preparation, a final transaction detects the changed document, defers the message for 60 seconds and prepares it again. Paid/cancelled/ineligible targets or invalid policies are held without starting transport.

Once `first_attempt_at` is durably recorded, uncertain retries preserve the frozen provider request, PDF, sender and idempotency key. A later payment, cancellation or policy edit cannot recall transport that has already started. This boundary retains the Phase 2 renewable claims, stale-worker fencing, bounded shutdown and existing 23-hour provider retry safety window. Durable event uniqueness and provider idempotency do not promise exactly one external HTTP request under every network failure.

### Reminder API contract

| Method and endpoint                       | Input and result                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reminders`                      | `organizationId`, optional `q`, `status` (all, overdue, due_today, upcoming), `page`. Returns `items`, counters, policy, public sender status and pagination.                    |
| `GET /api/reminders/history`              | `organizationId`, optional `page`. Returns paginated serialized reminder message metadata and reminder descriptors.                                                              |
| `GET /api/reminders/policy`               | `organizationId`; returns `{ policy }`.                                                                                                                                          |
| `PUT /api/reminders/policy`               | Administrator JSON: `organizationId`, numeric `version`, boolean `enabled`, integer `offsets` array. Returns `{ policy }`; stale revisions conflict.                             |
| `GET /api/documents/:id/reminder-preview` | Optional `installmentId`; omission selects the invoice-level target. Authorization follows the invoice's business. Returns the current preview, public sender status and policy. |
| `POST /api/documents/:id/reminders`       | JSON `installmentId` (string or null) and current `dueDate`. Returns HTTP 202 with `{ message, duplicate }`.                                                                     |

The dashboard and history each use 50 rows per page. Dashboard counters cover all eligible dated unpaid targets before text/status filters, including targets whose sender or recipient currently prevents sending. Reminder monetary fields retain the existing application's **INR number** contract; they are not the ledger API's `…Paise` fields. Message history excludes private payloads and PDF data.

Implementation: [reminder service](../src/services/integrations/email/payment-reminders.js), [eligibility and timing rules](../src/services/integrations/email/reminder-rules.js), [mailer](../src/services/integrations/email/mailer.js) and [controller](../src/controllers/api/reminders.controller.js).

## 3. Recurring invoice drafts

### Create and review a schedule

An administrator opens **Receivables → Recurring invoices → Choose a source invoice**. Search finds the latest 25 matching saved, noncancelled invoices in the selected business. Choose **Use invoice**, review the source and copied items, then choose a schedule name, frequency, start date, due-day offset and optional end/occurrence limit.

Creation defaults to paused; activation is an explicit choice. An active schedule becomes eligible on its next date in India. **Generate due draft now** creates its one currently pending occurrence. Every generated document is a new **draft** with a new ID and the standard number for its scheduled issue date's financial year. Open it from the occurrence history, review the current snapshots and amounts, and issue it through the existing invoice workflow.

Recurring generation does not issue invoices, send an email or charge a customer. It never copies receipts, payment links, installments, finalization, conversion or delivery state. The source invoice is unchanged.

### What is frozen and what is revalidated

Schedule creation freezes the source invoice's commercial inputs: items, quantities, rates, discount, place of supply, title, notes, terms and branding, together with the chosen customer, catalog, product, GST registration and format references. Later edits to the source invoice do not change the schedule template.

Each occurrence revalidates the current business, customer, catalog, product and format through the existing workspace service. It uses current identity/tax/format snapshots and recalculates totals from the saved commercial inputs. An archived/missing/incompatible reference or changed business billing profile stops generation for review. The implementation does not inject an obsolete saved source snapshot to bypass current validation.

Frequency, anchor date and source template are immutable. To change what is billed or its cadence, pause the old schedule and explicitly create a replacement from a reviewed invoice. Name, due-day offset, end date and maximum occurrence count can be edited while a schedule is paused or needs review. Settings cannot silently discard the next pending occurrence; completed schedules remain history.

| Schedule setting    | Supported behavior                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frequency           | Weekly, monthly, quarterly or yearly.                                                                                                               |
| Calendar            | Exact dates from 2000 through 2199, evaluated using the Indian business day.                                                                        |
| Month-end anchor    | Always derived from the original start date: January 31 → February 28/29 → March 31. A leap-day yearly anchor returns to February 29 in leap years. |
| Invoice due date    | Scheduled issue date plus 0–365 calendar days.                                                                                                      |
| End date            | Optional and inclusive.                                                                                                                             |
| Occurrence limit    | Optional, 1–1200, including the first occurrence.                                                                                                   |
| Lists and histories | 25 schedules, occurrences or activity events per page; occurrence and activity pages are separate.                                                  |
| Automatic pass      | At most 20 due schedules, creating at most one occurrence for each selected schedule.                                                               |
| Automatic cooldown  | A successful occurrence persists a next-eligible time at least 60 seconds later.                                                                    |

### Backlog, failures and duplicate protection

After normal downtime, active schedules resume from their oldest pending date. Pending-through-today counts make the backlog visible. Each automatic pass advances it gradually; it does not generate the entire backlog in one operation. Pause stops future automatic generations while retaining the next date and history. **Review and resume** shows the pending date/backlog before restarting. Administrators can deliberately generate the next due draft themselves after reviewing it.

Schedule creation requires a UUID `requestId` and the saved source's `sourceVersion`. Repeating the same request/payload recovers the saved schedule. Reusing that request ID with changed input or creating from a stale source produces a conflict. The browser retains the exact unresolved request across reloads and offers **Retry saved request**; unavailable request storage blocks creation rather than discarding its identity.

Updates, pause/resume and generation use the saved numeric schedule `version`. A stale tab keeps its entered values and offers the latest saved version for comparison. Each occurrence has a durable unique schedule/date record, and document creation, numbering, occurrence history and schedule advancement commit together in the existing MongoDB transaction. A generation retry for an already committed date returns that occurrence even if the schedule has advanced. Deleting its draft does not delete the occurrence marker or allow that date to create a replacement invoice silently.

If current references or validation prevent generation, the transaction does not create a partial draft or advance the date. The failure and attempt are recorded, the schedule enters **Needs review** (`error`), and automatic retries stop. Repair the relevant records, review the unchanged next date and select **Review and resume**. A successful retry keeps the earlier failure in history. Reaching the date/count boundary marks the schedule completed.

### Recurring API contract

Read requests require `organizationId` in the query. Mutation requests require it in JSON and administrator access. Staff can read only their permitted businesses.

| Method and endpoint                         | Input and result                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/recurring-invoices`               | `organizationId`, optional `page`; projected schedules, pending counts and pagination.                                                                                                                                                                    |
| `GET /api/recurring-invoices/sources`       | `organizationId`, optional literal `q`; up to 25 matching source invoice summaries.                                                                                                                                                                       |
| `GET /api/recurring-invoices/:id`           | `organizationId`, optional `historyPage`, `eventPage`; schedule/template, occurrence history and activity with separate pagination.                                                                                                                       |
| `POST /api/recurring-invoices`              | `organizationId`, `sourceDocumentId`, numeric `sourceVersion`, UUID `requestId`, `name`, `frequency`, `startDate`, `dueDays`, optional `endDate`, `maxOccurrences`, `active`. Returns `{ created, schedule }`, HTTP 201 for creation or 200 for a replay. |
| `PUT /api/recurring-invoices/:id`           | `organizationId`, `version`, `name`, `dueDays`, optional `endDate` and `maxOccurrences`; updates reviewed editable settings.                                                                                                                              |
| `POST /api/recurring-invoices/:id/status`   | `organizationId`, `version`, `action: "pause"` or `"resume"`; returns the saved schedule.                                                                                                                                                                 |
| `POST /api/recurring-invoices/:id/generate` | `organizationId`, `version`, `occurrenceDate`; creates/replays the selected due occurrence and returns schedule, occurrence and document summary.                                                                                                         |

An omitted end date is empty, an omitted maximum occurrence limit is null, and `active` defaults to false. Generation returns HTTP 201 when created, 200 for a committed replay and 422 with `RECURRING_GENERATION_FAILED` for a recorded generation failure. Stale revision and changed creation-request conflicts use `RECURRING_VERSION_CONFLICT` and `RECURRING_REQUEST_CONFLICT` respectively. Unexpected errors retain the Phase 2 safe error/request-ID behavior.

Implementation: [recurring service and snapshot policy](../src/services/recurring/recurring-invoices.js), [calendar calculations](../shared/recurrence-dates.js), [controller](../src/controllers/api/recurring-invoices.controller.js) and [browser controls](../public/js/recurring/recurring.js).

## 4. Runtime, data and index principles

The normal HTTP runtime invokes the shared automation runner before processing the email queue. The runner begins no more frequently than once per **60 seconds per process**, coalesces overlapping passes and runs recurring generation followed by reminder scheduling. Its 60 seconds is a start interval, not an execution deadline. The existing 15-second worker tick checks when another pass is eligible. Automation requires a running application; no external cron, broker or scheduler account is provisioned.

On shutdown, the runner prevents further work and immediately asks both services to stop. Recurring generation already in progress and an in-flight reminder pass are awaited alongside HTTP requests, backups and the existing email worker. Phase 2 readiness becomes draining, the email worker retains its normal 20-second grace, and the production process retains its overall 30-second shutdown deadline.

The data additions are deliberately separate from financial source records:

| Collection or existing record                                    | Purpose and constraint                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `documents`, `payments`, `document_events`, `customers` | Ledger source data. No additional ledger collection or balance mutation is introduced. Organization/customer/invoice/date indexes support scoped reads.                                                                 |
| `payment_reminder_policies`                                      | One policy per organization, using organization ID as `_id`; revision and effective date govern automatic eligibility.                                                                                                  |
| Existing `email_outbox`                                          | New `payment_reminder` message kind with a structured reminder descriptor. The existing unique `event_key` and renewable claim rules remain authoritative. Added indexes support organization history and policy holds. |
| `recurring_invoice_schedules`                                    | Frozen template plus mutable progression/settings. Unique `(organizationId, requestId)` protects schedule creation; due and organization/list indexes support worker and page reads.                                    |
| `recurring_invoice_occurrences`                                  | Unique `(scheduleId, scheduledDate)` records the outcome and generated draft reference; retained after document deletion.                                                                                               |
| `recurring_invoice_events`                                       | Separate activity records for creation, edits, pause/resume, generation, completion and failures, indexed by organization/schedule/time.                                                                                |
| Generated invoice metadata                                       | `recurringScheduleId` and `recurringScheduledDate`; a partial unique index provides an additional occurrence constraint without affecting unrelated invoices.                                                           |

Ledger reads use a dedicated read-only MongoDB snapshot session so customer invoices and receipts agree during concurrent payment changes. They do not acquire or increment the application's write-transaction coordination lock. Automatic enqueue and recurring mutations retain that existing shared transaction lock, unique constraints and revision checks across processes.

All feature data is covered by the existing backup collection/index snapshot mechanism. No backfill creates a schedule, enables reminders, rewrites historical customer associations or guesses missing ledger history. Startup adds the new empty collections and indexes when upgrading an older database.

Implementation: [database/index registry](../src/config/database.js), [automation runner](../src/services/operations/automation-runner.js), [HTTP lifecycle](../src/services/operations/http-runtime.js) and [recovery](../src/services/operations/recovery.js).

## 5. Upgrade and recovery

### Upgrade an existing Phase 1/2 workspace

1. Keep a verified backup and the existing private configuration/data directories. Use the complete 2.3.0 project and matching browser assets; keep `.example.env` values private.
2. Stop all older application and worker processes during the coordinated upgrade. Older releases do not understand every new reminder/recurring recovery rule; Phase 1 workers also lack Phase 2's claim fencing. Do not mix these worker versions against the same outbox.
3. Install with `npm ci`, start against the existing transaction-capable MongoDB replica set or supported sharded deployment, and allow the additional collections/indexes to initialize. Plan index creation time for a large existing collection.
4. Check `/api/ready`, refresh browser tabs, sign in and review representative current customer totals and legacy notices. Existing `GET /api/documents` still returns its full array, and the existing Phase 1 request-ID/revision contracts remain in force.
5. Create/activate recurring schedules and enable reminder policies only after reviewing their inputs. A normal upgrade does not automatically opt any business into either feature.

The new endpoints and pages are additive. The MongoDB backup format, existing document calculation rules and `.example.env` loading remain compatible. See [Deployment](DEPLOYMENT.md) and [Migration, backup and recovery](MIGRATION.md) for the full installation/cutover procedure.

### Restore a snapshot, then review automations

Use the existing verified restore process into a new empty database, keeping the application stopped during review. Restore invalidates sessions/reset tokens, holds queued/sending messages, clears email claims and establishes the global recovery hold.

Phase 3 recovery additionally **disables every reminder policy** and **pauses every unfinished recurring schedule**, incrementing their revisions. It retains occurrence records, generated document references, pending dates and history. Completed schedules remain completed. Older snapshots without these collections restore normally; startup creates the absent collections.

Reconcile invoices, numbers, receipts, external payment/email activity and any drafts generated after the snapshot was taken. The existing `db:resume -- --database=NAME --acknowledge-reconciled` command acknowledges that review and releases the global hold. It does not enable reminder policies, resume recurring schedules or send held emails.

After signing in, review each unfinished schedule's next date, backlog and occurrence history before explicitly resuming it. Resume preserves the pending date and can generate older due drafts in bounded passes. A snapshot cannot know about a later occurrence missing from that snapshot; review prevents treating the restored database as complete post-snapshot history.

Review each business's sender and timing before re-enabling automatic reminders. The new policy revision/effective date prevents the scheduler from catching up missed reminder dates. Previously held unattempted automatic rows remain held; attempted requests must be reviewed against provider history before retry. A database restore cannot retract an email or payment already accepted by an external provider.

## 6. Verification and practical limits

This section records the Phase 3 release. [Phase 4](PHASE-4.md) subsequently fixes legacy receipt rounding, removes a redundant statement join, adds indexed automatic-reminder date selection and replaces the single global writer lock with fixed business stripes plus an exclusive fallback. Full-history reporting/dashboard memory limits and unavailable historical data remain as described below.

See [Verification](VERIFICATION.md) for the final combined counts, commands and browser acceptance evidence. Dedicated tests exercise integer-paise and date boundaries; partial/full receipts, voids, cancellation and legacy-paid records; organization access; archived/same-name/missing contacts; full CSV/print pagination; snapshot consistency; reminder policy/queue/provider races; month-end recurrence; two-worker/repeated occurrence protection; lost responses; failures and restore review. Browser acceptance covers the authenticated EJS workflows, confirmation controls, stale forms, pagination, exports and 390-pixel layouts.

These checks use disposable native MongoDB replica sets and controlled provider responses. They do not constitute a live payment/email delivery test, production data migration, hosting deployment or large-scale load benchmark.

The main remaining limits are explicit:

- A customer statement cannot reconstruct missing invoice status transitions or missing historical settlement dates. It reports incomplete history rather than inventing balances.
- Ledger lists scan relevant projected records and retain customer summaries; individual statements calculate the customer's complete projected history before pagination. Full exports/print are intentionally complete and can consume more memory for very large accounts.
- Reminder dashboards scan projected invoices and retain matching lightweight targets for sorting/pagination. Queue limits bound newly created messages per pass, not the total number of records scanned.
- Recurring catch-up is bounded by schedule count/cooldown and current validation. It generates drafts for review and requires the application to remain running. It does not schedule issuance, customer delivery or collection.
- The existing shared write-transaction lock remains a scaling constraint. Provider idempotency, worker leases and event uniqueness protect retry identity, but do not eliminate all external-delivery uncertainty.

Page-specific loading, the full-array legacy documents API, backup inventory's `verified: false` / `verification: "on_download"` contract, full backup verification on download/restore, request-ID diagnostics and operational readiness continue from Phase 2.
