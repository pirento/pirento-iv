# Venturecore INV: accounts, online payments and email

The application now has a public home page, individual accounts, administrator approval, organization assignments, party records, verified Razorpay/Cashfree payment links and a persistent transactional email queue. It continues to use the existing SQLite database; invoice numbers, company details, assets, receipts and saved snapshots are preserved.

## Accounts

Set `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME` and `INITIAL_ADMIN_PASSWORD` securely in server settings for the first startup. The email must be yours and the password must have at least 12 characters. The first public signup never becomes an administrator. A conflicting pending account is not silently promoted. Existing owner passwords are not overwritten by startup settings. After a successful owner login, remove **both** `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from the startup environment.

All new signups are pending. An administrator opens **Team & access**, reviews the person's identity, approves their status and assigns organizations. Staff can work only with their assigned organizations. Administrators manage the company, organizations, users and integration setup. Disabling a user or changing their access revokes their sessions. The last active administrator cannot be disabled or demoted. Signups are requests for access to this company workspace, not independent tenants or customer portal accounts.

Passwords use salted asynchronous scrypt. Session tokens are random, hashed in SQLite, expire after 12 hours, and use HttpOnly SameSite cookies. Production requires `NODE_ENV=production` and an exact HTTPS `PUBLIC_APP_URL`. Account login protects the workspace. Do not put a separate shared-password gate in front of signed payment-provider webhooks. Cookie sessions protect all business APIs, including direct requests to another organization's record ID.

Forgot-password emails work after a sender is configured. Links expire after 30 minutes, work once, and reset existing sessions. Before email setup, the app shows reset delivery as unavailable. Never share bootstrap passwords, session tokens, payment-gateway keys or email-provider keys in chat, source code or frontend environment variables.

## Workspace pages and navigation

Business settings, contacts, documents, previews, payments, email, formats and other workspace tasks open as full pages. Browser Back and Forward follow the page history; a saved record's page can be refreshed or bookmarked. The active organization and requested record are resolved together, and the server independently checks permission on every business API call. Editing a URL does not grant access to another business.

Save a draft before depending on refresh to preserve entered data. Unsaved forms are not persistent business records. Adding a contact from a document uses a separate page and returns to the pending document; saving the document is still required. Delete confirmations appear within the page and never bypass the existing draft/reference restrictions. Browser-native file selection and print/PDF dialogs remain part of uploading and printing.

## Customers, vendors and B2B buyers

**Contacts** contains separate role filters and supports multiple roles on one record. Each record stays within its organization and may include email, phone, contact person, GSTIN/PAN, billing/shipping addresses, terms in days, a credit reference and internal notes. GST lookup remains available. Credit reference is informational; it does not automatically approve credit or block invoicing.

Any active customer, B2B buyer or vendor saved in the selected organization can be selected for a document. The document editor searches names, contact people, phone numbers, email addresses, GSTIN/PAN and addresses, with separate role filters. Records from other organizations never appear in the picker. Contact roles describe saved business relationships; they do not create staff accounts or grant login access. Archive/restore preserves historical references. Existing invoice snapshots and metadata edits remain usable when a live contact changes. Selecting a saved customer for a new document suggests their payment-term due date and shipping address, which can be edited. Vendor records do not yet create purchase orders, supplier bills or accounts-payable ledgers.

## Legal businesses, GST and payment details

The first five organizations are Venturecore divisions. **Shri Sarraf is an independent legal business**, with its own legal/trade names, GST registrations, contact details, bank account, QR, outgoing email configuration and Cashfree account. Choosing an organization changes the contact book and issuing business; it is not a staff-access setting. Team assignments separately decide who can access that organization's records.

In organization settings, review the legal business name, optional trade name, business relationship and default GST registration. Add named registrations only for that legal business. While drafting an invoice, quotation, proforma or delivery challan, use **Seller GST registration** to choose its saved GSTIN, registered address and state. Tax uses that supplier state and the place of supply, with editable per-line GST rates. A registration from another organization cannot be selected. Saved issued/final documents retain their legal identity, tax and payment snapshots when settings change.

Upload, replace or remove a payment QR and edit bank/account/IFSC details in **Payment details** at any time. Bank and QR are optional; leave them empty until the business provides them. New documents use the saved details; historical documents are not silently changed. A GST certificate's verification QR is not a payment QR. Private GST certificates, bank details and uploaded signatures must stay outside source archives and public assets.

Support defaults to **support@pirento.com** for Venturecore divisions and **support@shrisarraf.com** for Shri Sarraf. This is a customer contact shown on documents and used as email Reply-To; it does not provision a mailbox or verify an outgoing sender. Configure each required `EMAIL_FROM` identity with the email provider separately.

## Organization-specific server settings

Choose the gateway in organization settings: Razorpay, Cashfree or manual-only. Credentials stay in server settings, never editable invoice fields or frontend code. Venturecore divisions may use the shared `RAZORPAY_*`, `EMAIL_FROM`, `RESEND_API_KEY` and `EMAIL_AUTOMATION` defaults. An independent business, including Shri Sarraf, **never falls back** to those shared payment/email credentials or automation settings.

| Organization      | Environment prefix  | Organization ID for webhook URLs |
| ----------------- | ------------------- | -------------------------------- |
| Pirento legal     | `PIRENTO_LEGAL`     | `pipeline2-legal`                |
| Pirento ecosystem | `PIRENTO_ECOSYSTEM` | `pipeline2-ecosystem`            |
| AT Facility       | `AT_FACILITY`       | `at-facilities`                  |
| A T Elevator      | `A_T_ELEVATOR`      | `at-elevators`                   |
| INZARIO SPACE     | `INZARIO_SPACE`     | `ingenio-space`                  |
| Shri Sarraf       | `SHRI_SARRAF`       | `shri-sarraf`                    |

For newly created organizations, **Payments & email** shows the prefix and webhook path. The prefix is `ORG_` followed by the uppercase organization ID with non-alphanumeric characters replaced by underscores. Append `_` and the ordinary variable name, for example `PIRENTO_LEGAL_EMAIL_FROM`.

Credential groups are atomic: defining even one prefixed variable, including an empty value, disables shared fallback for the complete group. Set all three `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` values together; both `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` together; and both `EMAIL_FROM` / `RESEND_API_KEY` together. This prevents accidentally combining one business's sender or account ID with another business's secret. `EMAIL_AUTOMATION` and `CASHFREE_ENVIRONMENT` have separate prefixed values. Remove unused partial overrides rather than relying on blank values to restore fallback. Restart the service after changing server settings.

## Razorpay activation

The user has a Razorpay account. No credentials are configured in this cloud workspace, and no live payment was created during development.

1. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and a separate `RAZORPAY_WEBHOOK_SECRET` securely on the host. Begin with Razorpay **test** keys.
2. Prefer `https://YOUR_APP_HOST/api/webhooks/razorpay/:organizationId` for each applicable organization, registered in its Razorpay account with that account’s configured webhook secret. For example, Pirento legal uses `/api/webhooks/razorpay/pipeline2-legal`. The legacy `/api/webhooks/razorpay` route remains for the shared main account; independent merchant accounts use their organization-specific route. Subscribe to `payment_link.paid`, `payment_link.partially_paid`, `payment.captured`, `payment.failed`, `payment_link.cancelled`, and `payment_link.expired`.
3. Permit outbound HTTPS to `api.razorpay.com` and public inbound HTTPS to the signed webhook route. Do not put a staff login or shared preview password in front of the webhook. Request signatures are verified against the original raw body before parsing.
4. On an issued invoice with a remaining balance, open **Payments → Online payments**. Create a link, use the provider's test checkout, and confirm its webhook or **Verify payments** updates the receipt ledger and EMI schedule.
5. Validate a partial payment, full payment, failed attempt and webhook retry. Full captured payment finalizes the same invoice number. Change to live keys only when the account and hosted test flow are ready.

Links collect the remaining INR amount and accept part payments. No card or bank credentials are collected in this application. A browser redirect or a payment marked merely `authorized` never marks an invoice paid: the backend independently fetches and validates captured payment/link membership, amount and currency. Provider payment IDs and event IDs prevent duplicate credits. Ledger changes and receipt notifications commit together.

Manual payment changes and invoice status/financial changes are blocked while a payable or uncertain link remains active. Cancel the link through the app after verification before recording another receipt method. A request that times out during link creation is recovered by its unique reference, rather than blindly creating another link. Unexpected amounts or unresolved provider state require review. Verified gateway receipts cannot be manually voided. Refunds and chargebacks require a separate provider/reconciliation workflow; they are not silently treated as local receipt corrections.

Failed-payment emails require a failure that the provider can verifiably associate with this invoice's payment link. Unassociated events are ignored rather than assigning a failure to a customer by their email address. Delayed failures after an invoice is paid/cancelled do not request another payment.

## Cashfree activation for Shri Sarraf

The Cashfree adapter is implemented against the official SDK contract using API version `2026-01-01`. Its HTTP and signed-webhook flows are tested with simulated provider responses; no live Cashfree payment has been verified in this workspace.

1. Choose **Cashfree** for Shri Sarraf and configure `SHRI_SARRAF_CASHFREE_CLIENT_ID`, `SHRI_SARRAF_CASHFREE_CLIENT_SECRET` and `SHRI_SARRAF_CASHFREE_ENVIRONMENT=sandbox` securely on the host. The default environment is sandbox; the only live value is `production`. Never supply Venturecore's Razorpay credentials for this business.
2. Register `https://YOUR_APP_HOST/api/webhooks/cashfree/shri-sarraf` in the matching Cashfree environment. Enable the payment-link and payment success/failure notifications relevant to the account. Cashfree signs `x-webhook-timestamp` followed by the original raw body with its client secret; the server verifies `x-webhook-signature` before parsing. There is no separate Razorpay-style Cashfree webhook-secret variable.
3. Permit outbound HTTPS to `sandbox.cashfree.com` for tests and `api.cashfree.com` for production, and public inbound HTTPS to the signed route. Provider checkout remains on an allowed Cashfree HTTPS host; this app never collects card credentials.
4. Create a link for an issued Shri Sarraf invoice. Verify partial payments, full payment, failed attempts, duplicate webhook events and **Verify payments**. The backend fetches the link's orders and payments and checks business membership, successful payment state, amount and INR currency before posting to the ledger. Webhook claims and browser redirects alone cannot mark an invoice paid.
5. Confirm the provider account, HTTPS webhook and ledger reconciliation in sandbox before switching that business to production credentials. A configuration badge reports present settings, not a successfully tested merchant account.

An active or uncertain Cashfree link blocks competing offline payment changes just like Razorpay. Cancel/reconcile it before another payment method; an uncertain creation is recovered with its saved merchant link ID. Provider payment/event identities are scoped to the business so events cannot credit a different organization's invoice. The same invoice is finalized only after its verified balance is zero. A gateway choice or credential change does not rewrite previously issued invoices or move existing links to another account.

## Email activation

The user has not created a business sender yet. The implemented delivery adapter uses **Resend's HTTP API**, not Hostinger SMTP. A future Hostinger mailbox can be the business address, but sending through this adapter still requires a verified sender/domain in Resend. No mailbox, domain or paid service has been purchased or provisioned.

Configure shared `EMAIL_FROM` and `RESEND_API_KEY` for the Venturecore workspace/divisions after sender/domain verification, and permit outbound HTTPS to `api.resend.com`. Set `EMAIL_AUTOMATION=true` to enable their automatic messages. For Shri Sarraf, separately set `SHRI_SARRAF_EMAIL_FROM`, `SHRI_SARRAF_RESEND_API_KEY` and, when ready, `SHRI_SARRAF_EMAIL_AUTOMATION=true`. Main company email settings cannot send Shri Sarraf emails. Password-reset emails belong to the workspace and continue to use the shared sender and `support@pirento.com`. **Payments & email** shows configuration readiness without revealing keys. Configured flags mean settings are present; they do not prove the provider has accepted a real request.

- Issuing a quotation, proforma or invoice queues its email transactionally. Drafts are not emailed automatically. Issued invoices resolve a link using the issuing business's saved gateway when that business is configured. Without an online gateway configuration, the email explicitly has no online payment link.
- The worker prepares the current invoice/link and a PDF before contacting the email provider. PDF uses the saved template, paper size, branding, payment/EMI details and uploaded PNG/JPEG/WebP images. Server-side rendering never fetches arbitrary external image URLs; linked images are omitted with a PDF note. Upload images to include them.
- Manual **Email** opens recipient, payment-link choice and delivery history. An existing issued invoice retains its saved recipient snapshot; ensure its email is correct before issuing. Message request IDs make a retry of the same action idempotent.
- Recorded part payments, full payments and verified gateway failures queue notifications. Full-payment PDFs show the resulting Paid / Final invoice. Manual receipts remain manual records, not bank verification.
- When email setup, automatic sending or the recipient email is missing, a message is **Held**. Adding credentials later does not silently send the backlog. Review and explicitly retry eligible messages.
- Each queued invoice/payment email retains its organization and saved legal/support identity. Reply-To uses that document’s support address. On its first send, the worker freezes the sender, PDF, request body and a non-secret credential fingerprint. Retries never switch to another business account; a changed key/profile or a legacy attempt without a recorded profile is held for checking the original provider delivery log. API keys are never stored in the outbox.
- The worker runs every 15 seconds in the server process. It uses persistent leases, bounded retry backoff and provider idempotency keys. After the provider's safe retry window, ambiguous deliveries require checking its logs before a new send.
- **Accepted by provider** means the provider accepted the message, not that it reached the inbox. Bounces, spam classification, open tracking and confirmed delivery webhooks are not implemented.

## Sandbox GST lookup

Set `GST_PROVIDER=sandbox`, `SANDBOX_ENVIRONMENT=test`, `SANDBOX_API_KEY` and `SANDBOX_API_SECRET` in secure hosting settings; restart the server after changing them. Retrieve the matching test key/secret in Sandbox Console → Settings → API Keys. The server creates its own access token; customers and staff never receive credentials. An incomplete configuration stays disabled and does not silently switch to another provider. Test credentials must use the test environment; production credentials must use `SANDBOX_ENVIRONMENT=production`.

Allow outbound HTTPS to `test-api.sandbox.co.in` for tests and `api.sandbox.co.in` for production. Sandbox's test environment only responds to its documented saved examples and supplies mock data. Test mode is displayed before lookup and in the success message; it cannot verify a real customer's registration. For real customers use production mode after confirming the account's API permissions/credits. Configuration indicators show presence, not successful authentication.

From **Contacts**, enter a valid GSTIN and press **Fetch details**. The registered legal name, address, state and status are normalized from the provider response. Review and save the contact within its organization; lookup does not create/update records on its own, fetch phone/email, change the seller GST registration or rewrite old invoices. Paid requests are throttled and successful results cached for five minutes. Check again later for recent registration changes. Lookup calls are not automatically retried; expired/invalid tokens are cleared before the next deliberate attempt.

Real connection verification requires secure credentials and an authenticated query. Development tests use injected synthetic transport and cannot prove provider availability or credits. The credentials remain in the user's private file and have not been installed here. See the official [authentication](https://developer.sandbox.co.in/api-reference/authenticate) and [GST search](https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/public/search_gstin) documentation.

## Deployment and validation

Database operations include verified online backups, an admin backup page and opt-in automatic snapshots. Configure private persistent paths and follow [DATABASE_OPERATIONS.md](DATABASE_OPERATIONS.md) for new-file recovery and reconciliation. Run `npm run check:deployment` against actual host settings; its safe report separates required blockers from unconfigured optional providers.

Use one Node.js 24+ server, HTTPS and persistent storage for the SQLite file. See [PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md). The built app and APIs use one origin. Do not run multiple replicas against separate SQLite copies. Automatic emails require a running worker/server; a static-only host cannot provide this system.

`npm test` exercises authentication, organization access, contacts, financial locks, signed/deduplicated payment events, email persistence/retries, saved PDF layouts and existing invoice behavior. Provider tests use injected simulated HTTP responses; they create no real charges or external emails. Hostinger deployment, live Razorpay/Cashfree webhooks and payments, verified per-business sender delivery and live GST portal lookup remain separate activation checks.
