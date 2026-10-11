# Phase 1 — correctness fixes

Release: **2.1.0**. The application remains Express MVC, EJS, JavaScript and native MongoDB. This release implements the six Phase 1 areas from the review. Existing document kinds, pricing calculations, saved snapshots, payment providers and configuration filenames remain part of the application.

## What changed for users

| Area                | Updated behavior                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact selection   | A newly created contact returns only to the exact editor/draft that requested it. Standalone Contacts saves cannot replace the buyer in another invoice. The handoff is single-use and expires.                                                                        |
| Concurrent edits    | A stale save shows a conflict without discarding the entries on the screen. Open the latest saved version in another tab, compare the entries and deliberately apply the changes still needed. The full-document editor also offers an unsaved JSON recovery download. |
| Uncertain creation  | The first creation payload and its request ID are saved before the HTTP request. If its result is unknown, the editor retains the entries and offers **Retry save**. Retrying after a reload checks the same request and returns the same invoice.                     |
| Manual receipts     | New receipt dates cannot be after the current Indian business day. Valid historical receipts remain supported. Receipt amounts must be at least INR 0.01 and represent whole paise.                                                                                    |
| Gateway dates       | New Razorpay and Cashfree receipts derive their receipt date in `Asia/Kolkata`. The original verified provider instant is retained as `providerPaidAt` when supplied.                                                                                                  |
| Cancellation emails | Cancelling an invoice holds its invoice/payment emails whose first transport has not started. The worker checks the current document again before starting delivery.                                                                                                   |

### Browser recovery

An unknown save result is different from a validation rejection. After a network failure or uncertain server response, the new-document form is temporarily locked while **Retry save** resolves the original payload. It does not silently generate a new request ID. A confirmed validation rejection leaves the form editable for correction.

If a copied tab tries to reuse an already committed request ID with different fields, the server returns a conflict and a linkable reference to the saved document. The original entries remain available for comparison. If that draft was subsequently deleted, the old request is rejected instead of recreating it.

Browser session storage must be available and have enough space to retain a new draft's save request. If storage is blocked or full, the editor explains the issue and sends no creation request. This prevents an unsafe save that cannot be identified after a reload. Existing pending drafts are retained across refreshes within that browser session. This is browser recovery, not a shared cloud autosave service.

## API contract

### Create: `POST /api/documents`

The normal document fields are unchanged. The updated browser also supplies a UUID `requestId`:

```json
{
  "requestId": "a054c81d-5151-4c35-a4e5-e02083136ab7"
}
```

This is an additional field in the complete document request, not the complete request body.

| Situation                                                | Response                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| First successful request                                 | `201`, saved document with `version: 1`.                                                                                          |
| Same organization, request ID and parsed document fields | `200`, the current version of that same saved document. No new number or automatic email.                                         |
| Same request ID with different document fields           | `409`, code `DOCUMENT_REQUEST_CONFLICT`; saved document identity is included if still available and within the same organization. |
| Previously created draft has been deleted                | `409`, code `DOCUMENT_REQUEST_CONFLICT`; no recreation.                                                                           |
| Request fails before commit                              | No request record, document or sequence change is committed. The corrected request may reuse its ID.                              |

Object property ordering does not affect the request hash; meaningful array order does. Request IDs are scoped to an organization and normalized to lowercase. Matching retries return the current saved document so later legitimate edits are not overwritten by a frozen creation response.

`requestId` remains optional for older API integrations. Requests that omit it retain the original create-on-each-call behavior and **do not have retry deduplication**. Integrations should send and retain a UUID for each intended new document. Automatic retries must reuse the exact same business fields and ID.

### Update: `PUT /api/documents/:id`

Full-document updates must include the numeric `version` from the last document response:

```json
{
  "version": 3
}
```

This is an additional field in the complete update body. A matching update returns the incremented version. Missing or stale versions return `409` with code `DOCUMENT_VERSION_CONFLICT`. Invalid version types return `400`. This requirement intentionally closes the old unguarded-update path; integrations must read the latest document and include its version.

Do not fetch a fresh revision and blindly attach it to an old full document body. Reconcile the actual latest fields with the user's intended changes. The browser conflict flow keeps the old form available and opens a fresh editor for this purpose.

Every internal document change advances the revision too, including receipt/void balance updates, installment changes and conversion links. Receipt, void, finalization and conversion actions keep their existing request formats and load the current document inside their transaction before saving.

The dedicated `PUT /api/documents/:id/installments` endpoint replaces a complete plan, so it also requires `{ "plan": ..., "version": ... }`. A stale plan replacement or removal returns the same `DOCUMENT_VERSION_CONFLICT` without changing the current schedule or its history. The browser captures the revision when the schedule editor or removal confirmation opens; refreshing other payment information cannot silently rebase an unsaved plan.

### Receipts

New manual receipts must use `paidOn` no later than the injected application clock's `Asia/Kolkata` calendar date. The existing date range and calendar validation still apply. Future installment due dates remain valid because schedules describe planned collections.

Amount validation rejects fractional paise and zero-after-rounding amounts, while normalizing ordinary floating-point noise such as `0.1 + 0.2`. Accepted amounts are normalized before receipt idempotency comparison. A previously saved matching receipt returns before the new-date check, so a clock adjustment does not invalidate an existing successful retry.

Public receipt input cannot claim to be a verified provider receipt by adding `providerPaidAt`. Only the trusted gateway callback supplies that metadata. A malformed provided gateway timestamp fails before crediting; a missing timestamp retains the existing application-clock fallback. Existing stored receipt dates are not rewritten.

### Email cancellation boundary

Cancellation holds invoice, payment-received, payment-paid and payment-failed messages that have no first transport timestamp. An eligible queued or claimed message is held even if it was created before this release. Held cancellation messages cannot be released through the ordinary retry action while the document remains cancelled.

The worker checks eligibility before preparation and again in the transaction that records the first transport timestamp. Cancellation that commits before this boundary prevents the first provider request. Cancellation during PDF preparation is covered, including preparation that subsequently fails.

An email already accepted by the provider, in flight, or previously attempted with an unknown outcome cannot be recalled. Such retries retain the exact saved request and provider idempotency key; they do not regenerate the document, attachment, sender or payment link. Earlier attempted messages with incomplete frozen delivery data remain held for review instead of being rewritten under the old key.

## Existing database and deployment

1. Keep the existing database connection and private configuration values. The distributed `.example.env` remains a blank credential template and is still loaded directly; hosting environment variables take precedence.
2. Install the updated application dependencies with `npm ci` and restart the updated server. Deploy browser assets and backend together. Existing open editor tabs should be refreshed before further edits.
3. Startup creates the `document_requests` collection and its unique index. Existing unversioned documents are exposed as `version: 0` and upgraded on their first guarded save; no bulk rewrite of financial history is required.
4. Full application backups include request records, document versions and indexes. Restore continues to use an empty target and the existing recovery hold. Old backups without request records remain readable, but cannot reconstruct request histories that did not exist in that backup.

Do not run older application code alongside this release: an old writer does not participate in document revision checks. Use a coordinated application restart for the upgrade. Existing application startup, replica-set requirements and database recovery instructions remain in [Deployment](DEPLOYMENT.md) and [Migration](MIGRATION.md).

## Verification

Focused regression tests are included:

- `tests/editor-state.test.js`: contact handoff ownership/single use, storage failures, revision-aware draft restoration and persisted creation requests.
- `tests/payment-validation.test.js`: minimum/whole-paise amounts, normal decimal noise, Indian business dates and untrusted provider metadata.
- `tests/integration/document-writes.test.js`: creation replay across instances, one number/email, conflicting bodies, failed creation, deleted drafts, stale edits, ledger revision changes, legacy documents and stale installment replacement/removal.
- `tests/integration/payment-correctness.test.js`: native MongoDB receipt/date boundaries, historical retries and both gateway timestamp paths.
- `tests/integration/email-cancellation.test.js`: queued/cancelled eligibility, cancellation during preparation, transport boundary, exact uncertain retries and password reset preservation.

Run the included source, unit and native MongoDB checks as described in [Verification](VERIFICATION.md). Browser acceptance checks cover standalone contact creation, intended contact return, two-editor conflicts, a lost successful response followed by reload/retry, corrected validation input, creation conflicts, storage failure and a real one-paise manual receipt. Installment browser checks cover two-tab plan conflicts, history refresh during editing and stale plan removal.

## Later phases

At the time of the 2.1.0 release, page-specific queries, backup-navigation performance, the full worker lease redesign, readiness/logging, the mobile menu and draft start-fresh controls were deferred. They are now implemented in [Phase 2, release 2.2.0](PHASE-2.md), which includes all Phase 1 fixes.

Customer ledgers, reminders, automatic recurring invoice generation and a broader high-volume concurrency redesign remain later-phase work. Existing recurring-period pricing remains available; it is separate from automatic recurring invoice generation.
