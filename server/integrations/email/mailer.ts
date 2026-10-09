import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  balanceDue,
  calculateLineAmount,
  DOCUMENT_LABELS,
  installmentBalances,
  money,
  paidAmount,
  pricingDescription,
  type BusinessDocument,
  type Organization,
} from '../../../shared/types.ts';
import { isIndependentBusiness } from '../../../shared/business-identity.ts';
import { organizationEnvironment } from '../../config/business-config.ts';
import { readProviderJson } from '../provider-http.ts';
import type {
  EmailIntegrationStatus,
  EmailKind,
  EmailMessage,
  EmailStatus,
} from '../../../shared/messaging-types.ts';

type Environment = Record<string, string | undefined>;
interface Options {
  getOrganization?: (id: string) => Organization | undefined;
  env?: Environment;
  fetch?: typeof fetch;
  now?: () => Date;
  renderInvoiceAttachment?: (document: BusinessDocument) => Promise<{ filename: string; content: string }>;
  resolveInvoicePaymentUrl?: (
    document: BusinessDocument,
  ) => Promise<{ document: BusinessDocument; paymentUrl?: string }>;
}
interface EnqueueOptions {
  eventKey: string;
  paymentUrl?: string;
  automatic?: boolean;
  resolvePaymentLink?: boolean;
}
interface PaymentEmailOptions extends EnqueueOptions {
  outcome: 'failed' | 'received' | 'paid';
  amount?: number;
  reference?: string;
}
interface SenderProfile {
  organizationId?: string;
  businessType: string;
  keyFingerprint: string;
  replyTo: string;
}
interface EmailPayload {
  organizationId?: string;
  senderProfile?: SenderProfile;
  html: string;
  text: string;
  document?: BusinessDocument;
  attachment?: { filename: string; content: string };
  expiresAt?: string;
  sender?: string;
  resolvePaymentLink?: boolean;
}
interface OutboxRow {
  id: string;
  document_id: string | null;
  kind: EmailKind;
  recipient: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  next_attempt_at: string | null;
  lease_until: string | null;
  first_attempt_at: string | null;
  last_error: string;
  provider_id: string;
  has_payment_link: number;
  payload: string;
}

const MAX_ATTEMPTS = 6;
const LEASE_MS = 5 * 60_000;
// Resend keeps idempotency keys for 24 hours. Ambiguous requests older than this
// window require provider review, rather than risking a second delivery.
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60_000;
const validEmail = (value: string) => value.length <= 254 && z.string().email().safeParse(value).success;
const escaped = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const textLines = (value: string) => escaped(value).replace(/\r?\n/g, '<br>');
const heading = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 200);

export class EmailQueueError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'EmailQueueError';
  }
}

export function validPaymentEmailUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      [
        'rzp.io',
        'rzp.to',
        'razorpay.com',
        'pages.razorpay.com',
        'payments.cashfree.com',
        'sandbox.cashfree.com',
        'cashfree.com',
        'www.cashfree.com',
      ].includes(hostname)
    );
  } catch {
    return false;
  }
}

function validatePaymentUrl(value?: string, org?: Organization) {
  if (value && !validPaymentEmailUrl(value))
    throw new EmailQueueError('Use a verified HTTPS Razorpay or Cashfree payment link.');
  if (value && org) {
    const actual = new URL(value).hostname.endsWith('cashfree.com') ? 'cashfree' : 'razorpay';
    const expected = org.paymentGateway ?? (org.id === 'shri-sarraf' ? 'cashfree' : 'razorpay');
    if (actual !== expected)
      throw new EmailQueueError('This payment link does not match the issuing business payment gateway.');
  }
}

function legalIdentity(org: Organization) {
  return org.tradeName && org.tradeName !== org.legalName
    ? `${org.tradeName} · Legal name: ${org.legalName}`
    : org.legalName;
}

function supportAddress(org?: Organization) {
  const configured = org?.supportEmail?.trim() ?? '';
  return validEmail(configured)
    ? configured
    : org?.id === 'shri-sarraf'
      ? 'support@shrisarraf.com'
      : 'support@pirento.com';
}

function emailFrame(title: string, body: string, company: string, support = 'support@pirento.com') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(title)}</title></head><body style="margin:0;padding:24px 12px;background:#f3f5f9;color:#182339;font-family:Arial,Helvetica,sans-serif"><main style="max-width:700px;margin:auto;background:#fff;padding:28px;border-radius:16px"><p style="font-size:12px;letter-spacing:1px;color:#576783">${escaped(company)}</p><h1 style="font-size:25px;line-height:1.3">${escaped(title)}</h1>${body}<hr style="border:0;border-top:1px solid #e4e9f1;margin-top:28px"><p style="font-size:12px;color:#68758b">This email records the invoice or payment status at the time it was created. Contact the issuing organization for any correction.</p><p style="font-size:12px;color:#68758b">Issued by ${escaped(company)}. Support: <a href="mailto:${escaped(support)}">${escaped(support)}</a></p></main></body></html>`;
}

function documentContents(doc: BusinessDocument) {
  const org = doc.organizationSnapshot,
    customer = doc.customerSnapshot;
  const rows = doc.items
    .map(
      (item) =>
        `<tr><td style="padding:10px 5px;border-bottom:1px solid #e4e9f1;word-break:break-word">${textLines(item.description)}${pricingDescription(item) ? `<br><small>${escaped(pricingDescription(item))}</small>` : ''}${item.hsn ? `<br><small>HSN/SAC: ${escaped(item.hsn)}</small>` : ''}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(item.quantity)} ${escaped(item.unit || '')}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(money(item.rate))}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(item.gstRate)}%</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(money(calculateLineAmount(item)))}</td></tr>`,
    )
    .join('');
  const totals: [string, number][] = [
    ['Subtotal', doc.totals.subtotal],
    ['Discount', -doc.totals.discount],
    ['Taxable value', doc.totals.taxable],
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['IGST', doc.totals.igst],
    ['Total', doc.totals.total],
  ];
  if (doc.kind === 'invoice') totals.push(['Received', paidAmount(doc)], ['Outstanding', balanceDue(doc)]);
  const schedule = installmentBalances(doc);
  const planHtml = schedule.length
    ? `<h3>Payment schedule · ${escaped(doc.installmentPlan!.name)}</h3><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Installment</th><th align="left">Due date</th><th align="right">Amount</th><th align="right">Balance</th></tr></thead><tbody>${schedule.map((entry) => `<tr><td style="padding:6px">${escaped(entry.label)}</td><td>${escaped(entry.dueDate)}</td><td align="right">${escaped(money(entry.amount))}</td><td align="right">${escaped(money(entry.balanceDue))}</td></tr>`).join('')}</tbody></table>`
    : '';
  const html = `<h2 style="font-size:18px">${escaped(org.name)}</h2><p>${textLines(org.address)}${org.gstin ? `<br>GSTIN: ${escaped(org.gstin)}` : ''}</p><p><strong>${escaped(DOCUMENT_LABELS[doc.kind])} ${escaped(doc.number)}</strong><br>Issued: ${escaped(doc.issueDate)}${doc.dueDate ? `<br>Due: ${escaped(doc.dueDate)}` : ''}${doc.businessProductSnapshot ? `<br>Product: ${escaped(doc.businessProductSnapshot.name)}` : ''}</p><p><strong>Bill to: ${escaped(customer.name)}</strong><br>${textLines(customer.address)}${customer.gstin ? `<br>GSTIN: ${escaped(customer.gstin)}` : ''}</p><table style="width:100%;border-collapse:collapse;font-size:13px"><thead style="background:#edf2fa"><tr><th align="left" style="padding:9px 5px">Description</th><th align="right">Qty</th><th align="right">Rate</th><th align="right">GST</th><th align="right">Amount</th></tr></thead><tbody>${rows}</tbody></table><table style="width:100%;margin-top:16px;border-collapse:collapse">${totals.map(([label, value]) => `<tr><td style="padding:5px 0">${escaped(label)}</td><td align="right" style="padding:5px 0"><strong>${escaped(money(value))}</strong></td></tr>`).join('')}</table>${planHtml}${doc.notes ? `<h3>Notes</h3><p>${textLines(doc.notes)}</p>` : ''}${doc.terms ? `<h3>Terms</h3><p>${textLines(doc.terms)}</p>` : ''}${org.email || org.phone ? `<p>Contact: ${escaped([org.email, org.phone].filter(Boolean).join(' · '))}</p>` : ''}`;
  const text = [
    org.legalName,
    org.name,
    org.address,
    org.gstin ? `GSTIN: ${org.gstin}` : '',
    `${DOCUMENT_LABELS[doc.kind]} ${doc.number}`,
    `Issued: ${doc.issueDate}`,
    doc.dueDate ? `Due: ${doc.dueDate}` : '',
    `Bill to: ${customer.name}`,
    customer.address,
    customer.gstin ? `GSTIN: ${customer.gstin}` : '',
    ...doc.items.map(
      (item) =>
        `${item.description} | ${item.quantity} ${item.unit || ''} × ${money(item.rate)} | GST ${item.gstRate}% | ${money(calculateLineAmount(item))}${pricingDescription(item) ? `\n${pricingDescription(item)}` : ''}`,
    ),
    ...totals.map(([label, value]) => `${label}: ${money(value)}`),
    ...schedule.map(
      (entry) =>
        `${entry.label}: ${entry.dueDate}, amount ${money(entry.amount)}, balance ${money(entry.balanceDue)}`,
    ),
    doc.notes,
    doc.terms,
  ]
    .filter(Boolean)
    .join('\n');
  return { html, text };
}

function paymentAction(url?: string) {
  const provider = url && new URL(url).hostname.endsWith('cashfree.com') ? 'Cashfree' : 'Razorpay';
  return url
    ? {
        html: `<p style="margin:24px 0"><a href="${escaped(url)}" style="display:inline-block;background:#174fda;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px">Pay securely with ${provider}</a></p><p style="font-size:12px;word-break:break-all">Payment link: ${escaped(url)}</p>`,
        text: `Pay securely with ${provider}: ${url}`,
      }
    : {
        html: '<p>No online payment link is included in this email. Contact the issuing organization for payment instructions.</p>',
        text: 'No online payment link is included in this email. Contact the issuing organization for payment instructions.',
      };
}

function invoicePayload(doc: BusinessDocument, paymentUrl?: string): EmailPayload {
  validatePaymentUrl(paymentUrl, doc.organizationSnapshot);
  const content = documentContents(doc),
    action =
      doc.kind === 'invoice' && balanceDue(doc) > 0 ? paymentAction(paymentUrl) : { html: '', text: '' };
  const title = `${DOCUMENT_LABELS[doc.kind]} ${doc.number}`;
  return {
    organizationId: doc.organizationId,
    html: emailFrame(
      title,
      `<p>Hello ${escaped(doc.customerSnapshot.name)},</p>${content.html}${action.html}`,
      legalIdentity(doc.organizationSnapshot),
      supportAddress(doc.organizationSnapshot),
    ),
    text: `${title}\n\n${content.text}\n\n${action.text}\n\nIssued by ${legalIdentity(doc.organizationSnapshot)}. Support: ${supportAddress(doc.organizationSnapshot)}`,
    document: doc,
  };
}

export function createMailer(db: DatabaseSync, options: Options = {}) {
  const env = options.env ?? process.env,
    fetcher = options.fetch ?? fetch,
    now = options.now ?? (() => new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, document_id TEXT,
    kind TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('held','queued','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    sent_at TEXT, next_attempt_at TEXT, lease_until TEXT, first_attempt_at TEXT,
    last_error TEXT NOT NULL DEFAULT '', provider_id TEXT NOT NULL DEFAULT '',
    has_payment_link INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status,next_attempt_at);
  CREATE INDEX IF NOT EXISTS email_outbox_document ON email_outbox(document_id,created_at);`);

  function configuration(organizationId?: string, snapshot?: Organization) {
    const org = organizationId
      ? options.getOrganization
        ? options.getOrganization(organizationId)
        : snapshot
      : undefined;
    // A missing/deleted business must never silently use the workspace sender.
    const missing = Boolean(organizationId && (!org || org.id !== organizationId));
    const scoped = org ? organizationEnvironment(org, env) : organizationId ? {} : env;
    const from = (scoped.EMAIL_FROM ?? '').trim();
    const address = from.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/)?.[1] ?? from;
    const apiKey = (scoped.RESEND_API_KEY ?? '').trim();
    const configured = !missing && Boolean(apiKey) && !/[\r\n]/.test(from) && validEmail(address);
    const integration: EmailIntegrationStatus = {
      configured,
      provider: 'resend',
      from,
      organizationId,
      replyTo: supportAddress(org),
      automationEnabled: scoped.EMAIL_AUTOMATION === 'true',
      reason: configured
        ? ''
        : missing
          ? 'The issuing organization is unavailable. Restore its email configuration before retrying.'
          : 'Email sending is not configured for this business. Add its Resend API key and verified EMAIL_FROM address in server settings.',
    };
    return {
      integration,
      apiKey,
      profile: {
        organizationId,
        businessType: org && isIndependentBusiness(org) ? 'independent' : 'division',
        keyFingerprint: apiKey ? createHash('sha256').update(apiKey).digest('hex') : '',
        replyTo: supportAddress(org),
      } satisfies SenderProfile,
    };
  }
  function status(organizationId?: string): EmailIntegrationStatus {
    return configuration(organizationId).integration;
  }
  function payloadConfiguration(payload: EmailPayload) {
    const organizationId = payload.organizationId ?? payload.document?.organizationId;
    const resolved = configuration(organizationId, payload.document?.organizationSnapshot);
    // Reply-To accompanies the saved legal/footer identity, including on retries.
    resolved.profile.replyTo = supportAddress(payload.document?.organizationSnapshot);
    const identityMatches =
      !payload.document ||
      Boolean(
        organizationId &&
        payload.document.organizationId === organizationId &&
        payload.document.organizationSnapshot.id === organizationId,
      );
    const frozen = payload.senderProfile;
    const profileMatches =
      !frozen ||
      (frozen.organizationId === resolved.profile.organizationId &&
        frozen.businessType === resolved.profile.businessType &&
        frozen.keyFingerprint === resolved.profile.keyFingerprint);
    if (!identityMatches)
      resolved.integration = {
        ...resolved.integration,
        configured: false,
        reason: 'The email business does not match its saved invoice. Send a new invoice email.',
      };
    else if (!profileMatches)
      resolved.integration = {
        ...resolved.integration,
        configured: false,
        reason:
          'This message was prepared with different business email credentials. Check the original provider delivery log before creating a new message.',
      };
    return resolved;
  }
  function rowConfiguration(row: OutboxRow) {
    const payload = JSON.parse(row.payload) as EmailPayload;
    const resolved = payloadConfiguration(payload);
    if (row.first_attempt_at && payload.sender && !payload.senderProfile)
      resolved.integration = {
        ...resolved.integration,
        configured: false,
        reason:
          'This earlier email has no saved sender credential profile. Check its original provider delivery log before creating a new message.',
      };
    return resolved;
  }
  function safeRetry(row: OutboxRow) {
    if (row.kind === 'password_reset' && new Date(row.created_at).getTime() + 30 * 60_000 <= now().getTime())
      return false;
    return (
      !row.first_attempt_at ||
      now().getTime() - new Date(row.first_attempt_at).getTime() < SAFE_RETRY_WINDOW_MS
    );
  }
  function serialize(row: OutboxRow): EmailMessage {
    return {
      id: row.id,
      documentId: row.document_id,
      kind: row.kind,
      to: row.recipient,
      subject: row.subject,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      providerId: row.provider_id,
      hasPaymentLink: row.has_payment_link === 1,
      canRetry:
        (row.status === 'held' || row.status === 'failed') &&
        validEmail(row.recipient) &&
        rowConfiguration(row).integration.configured &&
        safeRetry(row),
    };
  }
  function get(id: string) {
    const row = db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) as unknown as
      OutboxRow | undefined;
    return row ? serialize(row) : null;
  }
  function listMessages(documentId: string) {
    return (
      db
        .prepare('SELECT * FROM email_outbox WHERE document_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(documentId) as unknown as OutboxRow[]
    ).map(serialize);
  }
  function enqueue(
    kind: EmailKind,
    to: string,
    subject: string,
    payload: EmailPayload,
    eventKey: string,
    documentId: string | null,
    hasPaymentLink = false,
    automatic = false,
  ) {
    if (!eventKey.trim() || eventKey.length > 240)
      throw new EmailQueueError('An email event identifier is required.');
    const existing = db.prepare('SELECT * FROM email_outbox WHERE event_key = ?').get(eventKey) as unknown as
      OutboxRow | undefined;
    if (existing) {
      if (
        existing.document_id !== documentId ||
        existing.kind !== kind ||
        ((JSON.parse(existing.payload) as EmailPayload).organizationId ??
          (JSON.parse(existing.payload) as EmailPayload).document?.organizationId) !== payload.organizationId
      )
        throw new EmailQueueError('This email event identifier is already in use.', 409);
      return serialize(existing);
    }
    const timestamp = now().toISOString(),
      config = payloadConfiguration(payload).integration;
    const recipient = to.trim();
    const hold = !validEmail(recipient)
      ? 'No valid customer email was saved with this invoice. Update the customer and draft invoice, then send a new email.'
      : !config.configured
        ? config.reason
        : automatic && !config.automationEnabled
          ? 'Automatic email sending is disabled. Enable EMAIL_AUTOMATION for future events, or explicitly release this message.'
          : '';
    const id = randomUUID();
    db.prepare(
      'INSERT INTO email_outbox (id,event_key,document_id,kind,recipient,subject,status,created_at,updated_at,next_attempt_at,last_error,has_payment_link,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING',
    ).run(
      id,
      eventKey,
      documentId,
      kind,
      recipient,
      heading(subject),
      hold ? 'held' : 'queued',
      timestamp,
      timestamp,
      hold ? null : timestamp,
      hold,
      Number(hasPaymentLink),
      JSON.stringify(payload),
    );
    const saved = db
      .prepare('SELECT * FROM email_outbox WHERE event_key=?')
      .get(eventKey) as unknown as OutboxRow;
    if (
      saved.document_id !== documentId ||
      saved.kind !== kind ||
      ((JSON.parse(saved.payload) as EmailPayload).organizationId ??
        (JSON.parse(saved.payload) as EmailPayload).document?.organizationId) !== payload.organizationId
    )
      throw new EmailQueueError('This email event identifier is already in use.', 409);
    return serialize(saved);
  }
  function enqueueInvoice(doc: BusinessDocument, input: EnqueueOptions) {
    const title = `${DOCUMENT_LABELS[doc.kind]} ${doc.number}`;
    return enqueue(
      'invoice',
      doc.customerSnapshot.email,
      `${title} · ${doc.organizationSnapshot.name}`,
      { ...invoicePayload(doc, input.paymentUrl), resolvePaymentLink: Boolean(input.resolvePaymentLink) },
      input.eventKey,
      doc.id,
      Boolean(input.paymentUrl && doc.kind === 'invoice' && balanceDue(doc) > 0),
      input.automatic,
    );
  }
  function enqueuePayment(doc: BusinessDocument, input: PaymentEmailOptions) {
    validatePaymentUrl(input.paymentUrl, doc.organizationSnapshot);
    const outcome = input.outcome === 'paid' && balanceDue(doc) > 0 ? 'received' : input.outcome;
    const title =
      outcome === 'failed'
        ? 'Payment unsuccessful'
        : outcome === 'paid'
          ? `Payment complete${doc.finalizedAt ? ' · Paid / Final' : ''}`
          : 'Part payment received';
    const summary =
      outcome === 'failed'
        ? 'The payment attempt was unsuccessful. No successful payment has been recorded for this attempt. If money was debited, contact your bank or the issuing organization before retrying.'
        : `${input.amount === undefined ? 'Your payment' : `Your payment of ${money(input.amount)}`} has been recorded.${outcome === 'paid' ? ' This invoice is fully paid.' : ` The remaining balance is ${money(balanceDue(doc))}.`}`;
    const content = documentContents(doc),
      action = balanceDue(doc) > 0 ? paymentAction(input.paymentUrl) : { html: '', text: '' };
    const reference = input.reference ? `Payment reference: ${input.reference}` : '';
    return enqueue(
      outcome === 'failed' ? 'payment_failed' : outcome === 'paid' ? 'payment_paid' : 'payment_received',
      doc.customerSnapshot.email,
      `${title} · ${doc.number}`,
      {
        organizationId: doc.organizationId,
        html: emailFrame(
          title,
          `<p>Hello ${escaped(doc.customerSnapshot.name)},</p><p>${escaped(summary)}</p>${reference ? `<p>${escaped(reference)}</p>` : ''}${content.html}${action.html}`,
          legalIdentity(doc.organizationSnapshot),
          supportAddress(doc.organizationSnapshot),
        ),
        text: `${title}\n\n${summary}\n${reference}\n\n${content.text}\n\n${action.text}\n\nIssued by ${legalIdentity(doc.organizationSnapshot)}. Support: ${supportAddress(doc.organizationSnapshot)}`,
        document: doc,
      },
      input.eventKey,
      doc.id,
      Boolean(input.paymentUrl && action.html),
      input.automatic,
    );
  }
  function enqueuePasswordReset(input: { to: string; name: string; resetUrl: string; eventKey: string }) {
    let url: URL;
    try {
      url = new URL(input.resetUrl);
    } catch {
      throw new EmailQueueError('A valid password reset URL is required.');
    }
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(
          env.NODE_ENV !== 'production' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new EmailQueueError('Password reset links require HTTPS.');
    const title = 'Reset your Venturecore INV password';
    return enqueue(
      'password_reset',
      input.to,
      title,
      {
        html: emailFrame(
          title,
          `<p>Hello ${escaped(input.name)},</p><p>Use the link below to choose a new password. This link is valid for 30 minutes and can be used once.</p><p><a href="${escaped(url.href)}" style="display:inline-block;background:#174fda;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
          'Venturecore Solutions Private Limited',
        ),
        text: `${title}\n\nHello ${input.name},\nUse this single-use link within 30 minutes: ${url.href}\nIf you did not request this, you can ignore this email.\nSupport: support@pirento.com`,
        expiresAt: new Date(now().getTime() + 30 * 60_000).toISOString(),
      },
      input.eventKey,
      null,
    );
  }
  function retry(id: string) {
    const row = db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) as unknown as
      OutboxRow | undefined;
    if (!row) throw new EmailQueueError('Email not found.', 404);
    if (!['held', 'failed'].includes(row.status))
      throw new EmailQueueError('Only held or failed messages can be retried.', 409);
    const config = rowConfiguration(row).integration;
    if (!config.configured) throw new EmailQueueError(config.reason, 503);
    if (!validEmail(row.recipient))
      throw new EmailQueueError(
        'This saved message has no valid recipient. Send a new invoice email after correcting the customer email.',
      );
    if (row.kind === 'password_reset' && new Date(row.created_at).getTime() + 30 * 60_000 <= now().getTime())
      throw new EmailQueueError('This password reset link has expired. Request a new password reset.', 409);
    if (!safeRetry(row))
      throw new EmailQueueError(
        'The provider idempotency window has elapsed. Check the provider delivery log before sending a new message.',
        409,
      );
    const timestamp = now().toISOString();
    db.prepare(
      "UPDATE email_outbox SET status='queued', attempts=0, next_attempt_at=?, updated_at=?, last_error='' WHERE id=?",
    ).run(timestamp, timestamp, id);
    return get(id)!;
  }

  let processing = false;
  async function processQueue(limit = 10) {
    db.prepare(
      "UPDATE email_outbox SET status='failed', payload='{}', lease_until=NULL, next_attempt_at=NULL, updated_at=?, last_error='This password reset link has expired. Request a new password reset.' WHERE kind='password_reset' AND status IN ('held','queued','failed') AND json_extract(payload,'$.expiresAt')<=?",
    ).run(now().toISOString(), now().toISOString());
    if (processing) return { processed: 0, sent: 0, failed: 0 };
    processing = true;
    const result = { processed: 0, sent: 0, failed: 0 };
    try {
      for (let i = 0; i < Math.min(Math.max(limit, 1), 100); i++) {
        const timestamp = now().toISOString();
        const row = db
          .prepare(
            "UPDATE email_outbox SET status='sending', attempts=attempts+1, updated_at=?, lease_until=? WHERE id=(SELECT id FROM email_outbox WHERE (status='queued' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY created_at LIMIT 1) RETURNING *",
          )
          .get(
            timestamp,
            new Date(now().getTime() + LEASE_MS).toISOString(),
            timestamp,
            timestamp,
          ) as unknown as OutboxRow | undefined;
        if (!row) break;
        result.processed++;
        if (!safeRetry(row)) {
          const reason =
            row.kind === 'password_reset'
              ? 'This password reset link has expired. Request a new password reset.'
              : 'Delivery is unconfirmed and the provider idempotency window has elapsed. Check the provider delivery log before sending a new message.';
          db.prepare(
            "UPDATE email_outbox SET status='failed', lease_until=NULL, next_attempt_at=NULL, payload=CASE WHEN kind='password_reset' THEN '{}' ELSE payload END, last_error=?, updated_at=? WHERE id=?",
          ).run(reason, timestamp, row.id);
          result.failed++;
          continue;
        }
        let acceptedId = '',
          failure = '',
          retryable = true,
          transportStarted = false;
        try {
          let payload = JSON.parse(row.payload) as EmailPayload;
          const config = rowConfiguration(row);
          if (!config.integration.configured) {
            db.prepare(
              "UPDATE email_outbox SET status='held', attempts=MAX(attempts-1,0), lease_until=NULL, next_attempt_at=NULL, last_error=?, updated_at=? WHERE id=?",
            ).run(config.integration.reason, timestamp, row.id);
            continue;
          }
          if (payload.expiresAt && payload.expiresAt <= timestamp) {
            db.prepare(
              "UPDATE email_outbox SET status='failed', lease_until=NULL, next_attempt_at=NULL, payload='{}', last_error=?, updated_at=? WHERE id=?",
            ).run('This password reset link has expired. Request a new password reset.', timestamp, row.id);
            result.failed++;
            continue;
          }
          let changed = false;
          if (payload.resolvePaymentLink && payload.document) {
            if (!options.resolveInvoicePaymentUrl)
              throw new EmailQueueError('Payment link setup is required.');
            const resolved = await options.resolveInvoicePaymentUrl(payload.document);
            if (
              resolved.document.id !== row.document_id ||
              resolved.document.organizationId !== payload.document.organizationId ||
              resolved.document.organizationSnapshot.id !== payload.document.organizationId
            )
              throw new EmailQueueError('Payment link document does not match.');
            if (
              resolved.document.kind === 'invoice' &&
              balanceDue(resolved.document) > 0 &&
              !resolved.paymentUrl
            )
              throw new EmailQueueError('The outstanding invoice needs a payment link.');
            payload = invoicePayload(resolved.document, resolved.paymentUrl);
            changed = true;
            db.prepare('UPDATE email_outbox SET has_payment_link=? WHERE id=?').run(
              Number(Boolean(resolved.paymentUrl && balanceDue(resolved.document) > 0)),
              row.id,
            );
          }
          if (!payload.sender) {
            payload.sender = config.integration.from;
            changed = true;
          }
          if (!payload.senderProfile) {
            payload.senderProfile = config.profile;
            changed = true;
          }
          if (payload.document && options.renderInvoiceAttachment && !payload.attachment) {
            payload.attachment = await options.renderInvoiceAttachment(payload.document);
            changed = true;
          }
          if (changed) {
            // Save the exact PDF before the network request. A retry must keep
            // an identical body with the provider's idempotency key.
            db.prepare('UPDATE email_outbox SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
          }
          // PDF/link preparation can yield to a concurrent business settings
          // change. Recheck the frozen identity before any external send.
          const latestConfig = payloadConfiguration(payload);
          if (!latestConfig.integration.configured) {
            db.prepare(
              "UPDATE email_outbox SET status='held', attempts=MAX(attempts-1,0), lease_until=NULL, next_attempt_at=NULL, last_error=?, updated_at=? WHERE id=?",
            ).run(latestConfig.integration.reason, now().toISOString(), row.id);
            continue;
          }
          db.prepare('UPDATE email_outbox SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?').run(
            now().toISOString(),
            row.id,
          );
          transportStarted = true;
          const response = await fetcher('https://api.resend.com/emails', {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `venturecore-email/${row.id}`,
            },
            body: JSON.stringify({
              from: payload.sender,
              reply_to: payload.senderProfile.replyTo,
              to: [row.recipient],
              subject: row.subject,
              html: payload.html,
              text: payload.text,
              ...(payload.attachment ? { attachments: [payload.attachment] } : {}),
            }),
            signal: AbortSignal.timeout(15_000),
          });
          const body = (await readProviderJson<{ id?: unknown }>(response, 16 * 1024).catch(() => ({}))) as {
            id?: unknown;
          };
          if (response.ok && typeof body.id === 'string' && body.id) acceptedId = body.id.slice(0, 200);
          else {
            retryable = response.status === 429 || response.status >= 500 || response.ok;
            failure = response.ok
              ? 'Email provider returned an unconfirmed result. The same delivery key will be retried.'
              : response.status === 401 || response.status === 403
                ? 'Email provider rejected the credentials or sender. Check server email settings.'
                : response.status === 429
                  ? 'Email provider rate limit reached. Delivery will be retried.'
                  : response.status >= 500
                    ? 'Email provider is temporarily unavailable. Delivery will be retried.'
                    : `Email provider rejected this message (HTTP ${response.status}). Check the verified sender and recipient.`;
          }
        } catch {
          failure = transportStarted
            ? 'Email provider could not be reached. Delivery will be retried with the same delivery key.'
            : 'The invoice email could not be prepared. Check payment link and PDF settings before retrying.';
        }
        const finished = now().toISOString();
        if (acceptedId) {
          db.prepare(
            "UPDATE email_outbox SET status='sent', sent_at=?, updated_at=?, lease_until=NULL, next_attempt_at=NULL, provider_id=?, last_error='', payload=CASE WHEN kind='password_reset' THEN '{}' ELSE payload END WHERE id=?",
          ).run(finished, finished, acceptedId, row.id);
          result.sent++;
        } else {
          const terminal = !retryable || row.attempts >= MAX_ATTEMPTS;
          const next = terminal
            ? null
            : new Date(now().getTime() + Math.min(60_000 * 2 ** (row.attempts - 1), 3_600_000)).toISOString();
          db.prepare(
            'UPDATE email_outbox SET status=?, updated_at=?, lease_until=NULL, next_attempt_at=?, last_error=? WHERE id=?',
          ).run(
            terminal ? 'failed' : 'queued',
            finished,
            next,
            terminal && retryable
              ? 'Automatic retries exhausted. Check provider delivery logs before retrying this message.'
              : failure,
            row.id,
          );
          if (terminal) result.failed++;
        }
      }
      return result;
    } finally {
      processing = false;
    }
  }
  return {
    status,
    get,
    listMessages,
    enqueueInvoice,
    enqueuePayment,
    enqueuePasswordReset,
    retry,
    processQueue,
  };
}

export type Mailer = ReturnType<typeof createMailer>;
