import { mapAsync } from '../../async-collections.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  balanceDue,
  calculateLineAmount,
  documentRoundingPolicy,
  DOCUMENT_LABELS,
  installmentBalances,
  money,
  paidAmount,
  pricingDescription,
} from '../../../../shared/types.js';
import { isIndependentBusiness } from '../../../../shared/business-identity.js';
import { organizationEnvironment } from '../../../config/business-config.js';
import { readProviderJson } from '../provider-http.js';
import { indiaBusinessDate } from '../../../../shared/business-date.js';
import {
  readReminderPolicy,
  reminderDocumentFingerprint,
  reminderEligibility,
  reminderSubject,
  reminderTargets,
} from './reminder-rules.js';
const MAX_ATTEMPTS = 6;
const LEASE_MS = 5 * 60_000;
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60_000;
const CANCELLED_DOCUMENT_REASON =
  'This document was cancelled before email delivery started. This unsent message is on hold.';
class EmailLeaseLostError extends Error {
  constructor() {
    super('This worker no longer owns the email delivery claim.');
    this.name = 'EmailLeaseLostError';
  }
}
class EmailWorkerStoppedError extends Error {
  constructor() {
    super('Email worker shutdown interrupted the local delivery attempt.');
    this.name = 'EmailWorkerStoppedError';
  }
}
function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    // Keep rejection handlers attached even when an uncooperative PDF renderer
    // or provider mock finishes after cancellation. Its result is then discarded.
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
const validEmail = (value) => value.length <= 254 && z.string().email().safeParse(value).success;
const escaped = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
const textLines = (value) => escaped(value).replace(/\r?\n/g, '<br>');
// eslint-disable-next-line no-control-regex -- rejects control characters on purpose
const heading = (value) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 200);
export class EmailQueueError extends Error {
  status;
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = 'EmailQueueError';
  }
}
export function validPaymentEmailUrl(value) {
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
function validatePaymentUrl(value, org) {
  if (value && !validPaymentEmailUrl(value))
    throw new EmailQueueError('Use a verified HTTPS Razorpay or Cashfree payment link.');
  if (value && org) {
    const actual = new URL(value).hostname.endsWith('cashfree.com') ? 'cashfree' : 'razorpay';
    const expected = org.paymentGateway ?? (org.id === 'shri-sarraf' ? 'cashfree' : 'razorpay');
    if (actual !== expected)
      throw new EmailQueueError('This payment link does not match the issuing business payment gateway.');
  }
}
function legalIdentity(org) {
  return org.tradeName && org.tradeName !== org.legalName
    ? `${org.tradeName} · Legal name: ${org.legalName}`
    : org.legalName;
}
function supportAddress(org) {
  const configured = org?.supportEmail?.trim() ?? '';
  return validEmail(configured)
    ? configured
    : org?.id === 'shri-sarraf'
      ? 'support@shrisarraf.com'
      : 'support@pirento.com';
}
function emailFrame(title, body, company, support = 'support@pirento.com') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(title)}</title></head><body style="margin:0;padding:24px 12px;background:#f3f5f9;color:#182339;font-family:Arial,Helvetica,sans-serif"><main style="max-width:700px;margin:auto;background:#fff;padding:28px;border-radius:16px"><p style="font-size:12px;letter-spacing:1px;color:#576783">${escaped(company)}</p><h1 style="font-size:25px;line-height:1.3">${escaped(title)}</h1>${body}<hr style="border:0;border-top:1px solid #e4e9f1;margin-top:28px"><p style="font-size:12px;color:#68758b">This email records the invoice or payment status at the time it was created. Contact the issuing organization for any correction.</p><p style="font-size:12px;color:#68758b">Issued by ${escaped(company)}. Support: <a href="mailto:${escaped(support)}">${escaped(support)}</a></p></main></body></html>`;
}
function documentContents(doc) {
  const roundingPolicy = documentRoundingPolicy(doc);
  const org = doc.organizationSnapshot,
    customer = doc.customerSnapshot;
  const rows = doc.items
    .map(
      (item) =>
        `<tr><td style="padding:10px 5px;border-bottom:1px solid #e4e9f1;word-break:break-word">${textLines(item.description)}${pricingDescription(item, roundingPolicy) ? `<br><small>${escaped(pricingDescription(item, roundingPolicy))}</small>` : ''}${item.hsn ? `<br><small>HSN/SAC: ${escaped(item.hsn)}</small>` : ''}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(item.quantity)} ${escaped(item.unit || '')}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(money(item.rate))}</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(item.gstRate)}%</td><td style="padding:10px 5px;text-align:right;vertical-align:top">${escaped(money(calculateLineAmount(item, roundingPolicy)))}</td></tr>`,
    )
    .join('');
  const totals = [
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
    ? `<h3>Payment schedule · ${escaped(doc.installmentPlan.name)}</h3><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Installment</th><th align="left">Due date</th><th align="right">Amount</th><th align="right">Balance</th></tr></thead><tbody>${schedule.map((entry) => `<tr><td style="padding:6px">${escaped(entry.label)}</td><td>${escaped(entry.dueDate)}</td><td align="right">${escaped(money(entry.amount))}</td><td align="right">${escaped(money(entry.balanceDue))}</td></tr>`).join('')}</tbody></table>`
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
        `${item.description} | ${item.quantity} ${item.unit || ''} × ${money(item.rate)} | GST ${item.gstRate}% | ${money(calculateLineAmount(item, roundingPolicy))}${pricingDescription(item, roundingPolicy) ? `\n${pricingDescription(item, roundingPolicy)}` : ''}`,
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
  return {
    html,
    text,
  };
}
function paymentAction(url) {
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
function invoicePayload(doc, paymentUrl) {
  validatePaymentUrl(paymentUrl, doc.organizationSnapshot);
  const content = documentContents(doc),
    action =
      doc.kind === 'invoice' && balanceDue(doc) > 0
        ? paymentAction(paymentUrl)
        : {
            html: '',
            text: '',
          };
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
function paymentReminderPayload(document, reminder, asOf) {
  const target = reminderTargets(document, asOf).find(
    (item) => item.installmentId === reminder.installmentId,
  );
  if (!target || target.dueDate !== reminder.dueDate)
    throw new EmailQueueError('This payment reminder no longer matches an unpaid due amount.', 409);
  const title =
    target.status === 'overdue'
      ? 'Payment overdue'
      : target.status === 'due_today'
        ? 'Payment due today'
        : 'Upcoming payment';
  const summary = `${target.label}: ${money(target.balanceDue)} remains due on ${target.dueDate}. The invoice balance is ${money(target.invoiceBalance)}.`;
  const content = documentContents(document);
  return {
    organizationId: document.organizationId,
    document,
    reminder: {
      automatic: reminder.automatic,
      installmentId: reminder.installmentId,
      dueDate: reminder.dueDate,
      offset: reminder.offset,
      scheduledFor: reminder.scheduledFor,
      policyVersion: reminder.policyVersion,
      label: target.label,
      preparedOn: asOf,
      balanceDue: target.balanceDue,
      invoiceBalance: target.invoiceBalance,
      documentFingerprint: reminderDocumentFingerprint(document),
    },
    html: emailFrame(
      title,
      `<p>Hello ${escaped(document.customerSnapshot.name)},</p><p>${escaped(summary)}</p><p>Please use the payment instructions on your invoice or contact the issuing business. If you have just paid, please share the payment reference so the balance can be checked.</p>${content.html}`,
      legalIdentity(document.organizationSnapshot),
      supportAddress(document.organizationSnapshot),
    ),
    text: `${title}\n\n${summary}\nPlease use the payment instructions on your invoice or contact the issuing business. If you have just paid, please share the payment reference so the balance can be checked.\n\n${content.text}\n\nIssued by ${legalIdentity(document.organizationSnapshot)}. Support: ${supportAddress(document.organizationSnapshot)}`,
  };
}
export function createMailer(db, options = {}) {
  const env = options.env ?? process.env,
    fetcher = options.fetch ?? fetch,
    now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const renewalMs = options.renewalMs ?? Math.floor(leaseMs / 3);
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 30 ||
    !Number.isSafeInteger(renewalMs) ||
    renewalMs < 1 ||
    renewalMs >= leaseMs
  )
    throw new TypeError('Email lease and renewal durations must be positive, with renewal before expiry.');
  const shutdown = new AbortController();
  let stopping = false;
  let activeRun = null;
  let stopPromise = null;
  function trackLease(row) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, shutdown.signal]);
    let timer;
    let renewal = null;
    let paused = false;
    let disposed = false;
    let finished = false;
    let lost = false;
    function lose() {
      lost = true;
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new EmailLeaseLostError());
    }
    async function renew() {
      if (disposed || signal.aborted) return false;
      if (renewal) return await renewal;
      renewal = (async () => {
        try {
          const timestamp = now().toISOString();
          const result = await abortable(
            () =>
              db.models.email.renew(
                timestamp,
                new Date(now().getTime() + leaseMs).toISOString(),
                row.id,
                row.claim_token,
              ),
            signal,
          );
          if (!result.changes) {
            lose();
            return false;
          }
          return true;
        } catch {
          if (!shutdown.signal.aborted) lose();
          return false;
        } finally {
          renewal = null;
        }
      })();
      return await renewal;
    }
    function schedule() {
      if (paused || disposed || signal.aborted) return;
      timer = setTimeout(async () => {
        await renew();
        schedule();
      }, renewalMs);
      timer.unref();
    }
    schedule();
    return {
      signal,
      renew,
      lose,
      run: (operation) => abortable(operation, signal),
      async pause() {
        paused = true;
        clearTimeout(timer);
        if (renewal) await renewal;
        signal.throwIfAborted();
      },
      finish() {
        finished = true;
      },
      get finished() {
        return finished;
      },
      get lost() {
        return lost;
      },
      dispose() {
        disposed = true;
        clearTimeout(timer);
      },
    };
  }
  async function completeClaim(lease, operation) {
    if (!(await lease.renew())) return false;
    // Do not let a heartbeat racing our own successful final write report an
    // ownership loss after that write has deliberately cleared its claim token.
    await lease.pause();
    const result = await lease.run(operation);
    if (!result.changes) {
      lease.lose();
      return false;
    }
    lease.finish();
    return true;
  }
  async function configuration(organizationId, snapshot) {
    const org = organizationId
      ? options.getOrganization
        ? await options.getOrganization(organizationId)
        : snapshot
      : undefined;
    const missing = Boolean(organizationId && (!org || org.id !== organizationId));
    const scoped = org ? organizationEnvironment(org, env) : organizationId ? {} : env;
    const from = (scoped.EMAIL_FROM ?? '').trim();
    const address = from.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/)?.[1] ?? from;
    const apiKey = (scoped.RESEND_API_KEY ?? '').trim();
    const configured = !missing && Boolean(apiKey) && !/[\r\n]/.test(from) && validEmail(address);
    const integration = {
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
      },
    };
  }
  async function status(organizationId) {
    return (await configuration(organizationId)).integration;
  }
  async function payloadConfiguration(payload) {
    const organizationId = payload.organizationId ?? payload.document?.organizationId;
    const resolved = await configuration(organizationId, payload.document?.organizationSnapshot);
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
  async function rowConfiguration(row) {
    const payload = row.payload;
    const resolved = await payloadConfiguration(payload);
    if (
      row.first_attempt_at &&
      (!payload.sender ||
        !payload.senderProfile ||
        payload.resolvePaymentLink ||
        (payload.document && options.renderInvoiceAttachment && !payload.attachment))
    )
      resolved.integration = {
        ...resolved.integration,
        configured: false,
        reason:
          'This earlier email has an incomplete saved delivery payload. Check its original provider delivery log before creating a new message.',
      };
    return resolved;
  }
  function safeRetry(row) {
    if (row.kind === 'password_reset' && new Date(row.created_at).getTime() + 30 * 60_000 <= now().getTime())
      return false;
    return (
      !row.first_attempt_at ||
      now().getTime() - new Date(row.first_attempt_at).getTime() < SAFE_RETRY_WINDOW_MS
    );
  }
  async function currentReminderEligibility(document, reminder) {
    const policy = reminder?.automatic ? await readReminderPolicy(db, document.organizationId) : null;
    return reminderEligibility(document, reminder, policy, indiaBusinessDate(now()));
  }
  async function firstDeliveryHoldReason(row) {
    // Once transport has started, the provider may already have accepted the email.
    // Its saved body, PDF and idempotency key must remain unchanged on retries.
    if (row.first_attempt_at || (!row.document_id && !row.payload.document)) return '';
    const snapshot = row.payload.document;
    const document = row.document_id && (await db.models.documents.findById(row.document_id));
    if (!document) return 'The document no longer exists. This unsent message is on hold.';
    if (
      !snapshot ||
      snapshot.id !== document.id ||
      snapshot.organizationId !== document.organizationId ||
      snapshot.organizationSnapshot?.id !== document.organizationId ||
      (row.payload.organizationId && row.payload.organizationId !== document.organizationId) ||
      snapshot.kind !== document.kind
    )
      return 'This email does not match its current document. This unsent message is on hold.';
    if (document.status === 'cancelled') return CANCELLED_DOCUMENT_REASON;
    if (document.status === 'draft')
      return 'The document is still a draft. Issue it before sending a document email.';
    if (row.kind === 'payment_reminder')
      return (await currentReminderEligibility(document, row.payload.reminder)).reason;
    return '';
  }
  async function holdCancelledDocument(document) {
    if (document.status !== 'cancelled') return;
    // The document controller calls this inside the cancellation transaction.
    // Rows already in provider transport are deliberately excluded from this hold.
    await db.models.email.holdUnattemptedForDocument(
      document.id,
      document.organizationId,
      CANCELLED_DOCUMENT_REASON,
      now().toISOString(),
    );
  }
  async function messageTransaction(id, action) {
    const initial = await db.models.email.findById(id);
    const documentId = initial?.document_id ?? null;
    const document = documentId ? await db.models.documents.findById(documentId) : undefined;
    const organizationId = document?.organizationId;
    return db.transaction(
      async () => {
        const current = await db.models.email.findById(id);
        if ((current?.document_id ?? null) !== documentId)
          throw new EmailQueueError('The saved message changed documents. Review it before retrying.', 409);
        if (organizationId) {
          const latest = await db.models.documents.findById(documentId);
          if (latest && latest.organizationId !== organizationId)
            throw new EmailQueueError(
              'The saved message changed businesses. Review it before retrying.',
              409,
            );
        }
        // Missing documents and password resets use the exclusive fallback. Financial
        // messages share their persisted document's organization, never a payload's
        // unverified ownership. The callback handles missing/expired messages normally.
        return action(current);
      },
      organizationId ? { organizationId } : undefined,
    );
  }
  async function beginTransport(row, lease) {
    return await messageTransaction(row.id, async (current) => {
      lease.signal.throwIfAborted();
      const timestamp = now().toISOString();
      if (
        current?.status !== 'sending' ||
        current.claim_token !== row.claim_token ||
        current.lease_until <= timestamp
      )
        return 'lost';
      if (!safeRetry(current)) {
        const reason =
          current.kind === 'password_reset'
            ? 'This password reset link has expired. Request a new password reset.'
            : 'Delivery is unconfirmed and the provider idempotency window has elapsed. Check the provider delivery log before sending a new message.';
        const result = await db.models.email.failUnsafeRetry(reason, timestamp, row.id, row.claim_token);
        return result.changes ? 'failed' : 'lost';
      }
      const reason = await firstDeliveryHoldReason(current);
      if (reason) {
        const result = await db.models.email.hold(reason, timestamp, row.id, row.claim_token);
        return result.changes ? 'held' : 'lost';
      }
      if (current.kind === 'payment_reminder' && !current.first_attempt_at) {
        const document = await db.models.documents.findById(current.document_id);
        const reminder = current.payload.reminder;
        if (
          reminder.documentFingerprint !== reminderDocumentFingerprint(document) ||
          reminder.preparedOn !== indiaBusinessDate(now()) ||
          current.recipient !== document.customerSnapshot.email ||
          current.subject !== heading(reminderSubject(document))
        ) {
          // Payments can change while a PDF is rendered. Preparing again is safe
          // before transport; an attempted provider request must never be rebuilt.
          const result = await db.models.email.deferReminderPreparation(
            'The invoice changed while preparing this reminder. Its current balance will be prepared again before sending.',
            timestamp,
            new Date(now().getTime() + 60_000).toISOString(),
            row.id,
            row.claim_token,
          );
          return result.changes ? 'deferred' : 'lost';
        }
      }
      // This durable transport boundary shares the cancellation transaction lock.
      // A cancellation committed before it prevents the first provider request.
      lease.signal.throwIfAborted();
      const result = await db.models.email.markFirstAttempt(now().toISOString(), row.id, row.claim_token);
      return result.changes ? 'sending' : 'lost';
    });
  }
  async function serialize(row) {
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
      ...(row.kind === 'payment_reminder' && row.payload.reminder
        ? {
            reminder: Object.fromEntries(
              [
                'automatic',
                'installmentId',
                'label',
                'dueDate',
                'offset',
                'scheduledFor',
                'preparedOn',
                'balanceDue',
                'invoiceBalance',
                'policyVersion',
              ].map((key) => [key, row.payload.reminder[key]]),
            ),
          }
        : {}),
      canRetry:
        (row.status === 'held' || row.status === 'failed') &&
        validEmail(row.recipient) &&
        (await rowConfiguration(row)).integration.configured &&
        safeRetry(row) &&
        !(await firstDeliveryHoldReason(row)),
    };
  }
  async function get(id) {
    const row = await db.models.email.findById(id);
    return row ? await serialize(row) : null;
  }
  async function listMessages(documentId) {
    return await mapAsync(await db.models.email.list(documentId), serialize);
  }
  async function listReminderMessages(organizationId, requestedPage = 1, pageSize = 50) {
    if (
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50
    )
      throw new EmailQueueError('The reminder history page is invalid.');
    const total = await db.models.email.countReminders(organizationId);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const rows = await db.models.email.listReminders(organizationId, (page - 1) * pageSize, pageSize);
    return { messages: await mapAsync(rows, serialize), pagination: { page, pageSize, total, pageCount } };
  }
  async function enqueue(
    kind,
    to,
    subject,
    payload,
    eventKey,
    documentId,
    hasPaymentLink = false,
    automatic = false,
  ) {
    if (!eventKey.trim() || eventKey.length > 240)
      throw new EmailQueueError('An email event identifier is required.');
    const existing = await db.models.email.findByEvent(eventKey);
    if (existing) {
      if (
        existing.document_id !== documentId ||
        existing.kind !== kind ||
        (existing.payload.organizationId ?? existing.payload.document?.organizationId) !==
          payload.organizationId
      )
        throw new EmailQueueError('This email event identifier is already in use.', 409);
      return await serialize(existing);
    }
    const timestamp = now().toISOString(),
      config = (await payloadConfiguration(payload)).integration,
      documentHold = await firstDeliveryHoldReason({ document_id: documentId, kind, payload });
    const recipient = to.trim();
    const hold =
      documentHold ||
      (!validEmail(recipient)
        ? 'No valid customer email was saved with this invoice. Update the customer and draft invoice, then send a new email.'
        : !config.configured
          ? config.reason
          : automatic && !config.automationEnabled
            ? 'Automatic email sending is disabled. Enable EMAIL_AUTOMATION for future events, or explicitly release this message.'
            : '');
    const id = randomUUID();
    await db.models.email.enqueue(
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
      payload,
    );
    const saved = await db.models.email.findByEvent(eventKey);
    if (
      saved.document_id !== documentId ||
      saved.kind !== kind ||
      (saved.payload.organizationId ?? saved.payload.document?.organizationId) !== payload.organizationId
    )
      throw new EmailQueueError('This email event identifier is already in use.', 409);
    return await serialize(saved);
  }
  async function enqueueInvoice(doc, input) {
    const title = `${DOCUMENT_LABELS[doc.kind]} ${doc.number}`;
    return await enqueue(
      'invoice',
      doc.customerSnapshot.email,
      `${title} · ${doc.organizationSnapshot.name}`,
      {
        ...invoicePayload(doc, input.paymentUrl),
        resolvePaymentLink: Boolean(input.resolvePaymentLink),
      },
      input.eventKey,
      doc.id,
      Boolean(input.paymentUrl && doc.kind === 'invoice' && balanceDue(doc) > 0),
      input.automatic,
    );
  }
  async function enqueueReminder(document, { reminder, eventKey }) {
    return await enqueue(
      'payment_reminder',
      document.customerSnapshot.email,
      reminderSubject(document),
      paymentReminderPayload(document, reminder, indiaBusinessDate(now())),
      eventKey,
      document.id,
      false,
      // Automatic reminders use their explicit, versioned per-business policy.
      // EMAIL_AUTOMATION continues to govern the existing invoice/receipt events.
      false,
    );
  }
  async function enqueuePayment(doc, input) {
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
      action =
        balanceDue(doc) > 0
          ? paymentAction(input.paymentUrl)
          : {
              html: '',
              text: '',
            };
    const reference = input.reference ? `Payment reference: ${input.reference}` : '';
    return await enqueue(
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
  async function enqueuePasswordReset(input) {
    let url;
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
    return await enqueue(
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
  async function retry(id) {
    return await messageTransaction(id, async (row) => {
      if (!row) throw new EmailQueueError('Email not found.', 404);
      if (!['held', 'failed'].includes(row.status))
        throw new EmailQueueError('Only held or failed messages can be retried.', 409);
      const documentHold = await firstDeliveryHoldReason(row);
      if (documentHold) throw new EmailQueueError(documentHold, 409);
      const config = (await rowConfiguration(row)).integration;
      if (!config.configured) throw new EmailQueueError(config.reason, 503);
      if (!validEmail(row.recipient))
        throw new EmailQueueError(
          'This saved message has no valid recipient. Send a new invoice email after correcting the customer email.',
        );
      if (
        row.kind === 'password_reset' &&
        new Date(row.created_at).getTime() + 30 * 60_000 <= now().getTime()
      )
        throw new EmailQueueError('This password reset link has expired. Request a new password reset.', 409);
      if (!safeRetry(row))
        throw new EmailQueueError(
          'The provider idempotency window has elapsed. Check the provider delivery log before sending a new message.',
          409,
        );
      const timestamp = now().toISOString();
      const result = await db.models.email.retry(timestamp, timestamp, id);
      if (!result.changes) throw new EmailQueueError('This message is already being processed.', 409);
      return await get(id);
    });
  }
  async function deliver(row, lease) {
    const hold = async (reason) =>
      (await completeClaim(lease, () =>
        db.models.email.hold(reason, now().toISOString(), row.id, row.claim_token),
      ))
        ? 'held'
        : 'lost';
    if (!safeRetry(row)) {
      const reason =
        row.kind === 'password_reset'
          ? 'This password reset link has expired. Request a new password reset.'
          : 'Delivery is unconfirmed and the provider idempotency window has elapsed. Check the provider delivery log before sending a new message.';
      return (await completeClaim(lease, () =>
        db.models.email.failUnsafeRetry(reason, now().toISOString(), row.id, row.claim_token),
      ))
        ? 'failed'
        : 'lost';
    }
    let acceptedId = '';
    let failure = '';
    let retryable = true;
    let transportStarted = false;
    try {
      let payload = row.payload;
      const documentHold = await lease.run(() => firstDeliveryHoldReason(row));
      if (documentHold) return await hold(documentHold);
      const config = await lease.run(() => rowConfiguration(row));
      if (!config.integration.configured) return await hold(config.integration.reason);
      if (payload.expiresAt && payload.expiresAt <= now().toISOString()) {
        return (await completeClaim(lease, () =>
          db.models.email.expireReset(
            'This password reset link has expired. Request a new password reset.',
            now().toISOString(),
            row.id,
            row.claim_token,
          ),
        ))
          ? 'failed'
          : 'lost';
      }
      // Prepare exactly once. A resumed attempt uses the persisted request body,
      // attachment and sender profile, together with the original delivery key.
      if (!row.first_attempt_at) {
        let changed = false;
        if (row.kind === 'payment_reminder') {
          const document = await lease.run(() => db.models.documents.findById(row.document_id));
          if (!document) return await hold('The invoice is unavailable. This payment reminder is on hold.');
          const eligibility = await lease.run(() => currentReminderEligibility(document, payload.reminder));
          if (eligibility.reason) return await hold(eligibility.reason);
          const preparedOn = indiaBusinessDate(now());
          if (
            payload.reminder.documentFingerprint !== reminderDocumentFingerprint(document) ||
            payload.reminder.preparedOn !== preparedOn ||
            row.recipient !== document.customerSnapshot.email ||
            row.subject !== heading(reminderSubject(document))
          ) {
            payload = {
              ...paymentReminderPayload(document, payload.reminder, preparedOn),
              ...(payload.sender ? { sender: payload.sender } : {}),
              ...(payload.senderProfile ? { senderProfile: payload.senderProfile } : {}),
            };
            row.recipient = document.customerSnapshot.email;
            row.subject = heading(reminderSubject(document));
            changed = true;
          }
        }
        if (payload.resolvePaymentLink && payload.document) {
          if (!options.resolveInvoicePaymentUrl) throw new EmailQueueError('Payment link setup is required.');
          if (!(await lease.renew())) return 'lost';
          const resolved = await lease.run(() =>
            options.resolveInvoicePaymentUrl(payload.document, { signal: lease.signal }),
          );
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
          const saved = await lease.run(() =>
            db.models.email.setPaymentLink(
              Number(Boolean(resolved.paymentUrl && balanceDue(resolved.document) > 0)),
              row.id,
              row.claim_token,
              now().toISOString(),
            ),
          );
          if (!saved.changes) return 'lost';
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
          payload.attachment = await lease.run(() =>
            options.renderInvoiceAttachment(payload.document, { signal: lease.signal }),
          );
          changed = true;
        }
        if (changed) {
          const saved = await lease.run(() =>
            row.kind === 'payment_reminder'
              ? db.models.email.setReminderPayload(
                  payload,
                  row.recipient,
                  row.subject,
                  row.id,
                  row.claim_token,
                  now().toISOString(),
                )
              : db.models.email.setPayload(payload, row.id, row.claim_token, now().toISOString()),
          );
          if (!saved.changes) return 'lost';
        }
      }
      const latestConfig = await lease.run(() => payloadConfiguration(payload));
      if (!latestConfig.integration.configured) return await hold(latestConfig.integration.reason);
      if (!(await lease.renew())) return 'lost';
      const transport = await lease.run(() => beginTransport(row, lease));
      if (transport !== 'sending') {
        if (transport !== 'lost') lease.finish();
        return transport;
      }
      transportStarted = true;
      const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
      const response = await abortable(
        () =>
          fetcher('https://api.resend.com/emails', {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: 'Bearer ' + config.apiKey,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'venturecore-email/' + row.id,
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
            signal,
          }),
        signal,
      );
      const body = await abortable(() => readProviderJson(response, 16 * 1024), signal).catch(() => {
        signal.throwIfAborted();
        return {};
      });
      if (response.ok && typeof body.id === 'string' && body.id) acceptedId = body.id.slice(0, 200);
      else {
        // Resend explicitly permits retrying a concurrent request with the same
        // idempotency key. A different-payload conflict remains terminal.
        const concurrent = response.status === 409 && body.name === 'concurrent_idempotent_requests';
        retryable = concurrent || response.status === 429 || response.status >= 500 || response.ok;
        failure = concurrent
          ? 'The provider is still processing this delivery key. The same request will be retried.'
          : response.ok
            ? 'Email provider returned an unconfirmed result. The same delivery key will be retried.'
            : response.status === 401 || response.status === 403
              ? 'Email provider rejected the credentials or sender. Check server email settings.'
              : response.status === 429
                ? 'Email provider rate limit reached. Delivery will be retried.'
                : response.status >= 500
                  ? 'Email provider is temporarily unavailable. Delivery will be retried.'
                  : 'Email provider rejected this message (HTTP ' +
                    response.status +
                    '). Check the verified sender and recipient.';
      }
    } catch {
      lease.signal.throwIfAborted();
      failure = transportStarted
        ? 'Email provider could not be reached. Delivery will be retried with the same delivery key.'
        : 'The invoice email could not be prepared. Check payment link and PDF settings before retrying.';
    }
    if (acceptedId) {
      return (await completeClaim(lease, () => {
        const finished = now().toISOString();
        return db.models.email.markSent(finished, finished, acceptedId, row.id, row.claim_token);
      }))
        ? 'sent'
        : 'lost';
    }
    const terminal = !retryable || row.attempts >= MAX_ATTEMPTS;
    return (await completeClaim(lease, () => {
      const finished = now().toISOString();
      const next = terminal
        ? null
        : new Date(now().getTime() + Math.min(60_000 * 2 ** (row.attempts - 1), 3_600_000)).toISOString();
      return db.models.email.markFailed(
        terminal ? 'failed' : 'queued',
        finished,
        next,
        terminal && retryable
          ? 'Automatic retries exhausted. Check provider delivery logs before retrying this message.'
          : failure,
        row.id,
        row.claim_token,
      );
    }))
      ? terminal
        ? 'failed'
        : 'queued'
      : 'lost';
  }
  const emptyResult = () => ({ processed: 0, sent: 0, failed: 0, lost: 0 });
  async function runQueue(limit) {
    const result = emptyResult();
    try {
      await abortable(
        () => db.models.email.expireResets(now().toISOString(), now().toISOString()),
        shutdown.signal,
      );
      for (let i = 0; i < Math.min(Math.max(limit, 1), 100) && !stopping; i++) {
        const timestamp = now().toISOString();
        const row = await abortable(
          () =>
            db.models.email.claim(
              timestamp,
              new Date(now().getTime() + leaseMs).toISOString(),
              timestamp,
              timestamp,
              randomUUID(),
            ),
          shutdown.signal,
        );
        if (!row) break;
        result.processed++;
        const lease = trackLease(row);
        try {
          if (stopping) continue;
          const outcome = await deliver(row, lease);
          if (outcome === 'sent') result.sent++;
          else if (outcome === 'failed') result.failed++;
          else if (outcome === 'lost') result.lost++;
        } catch (error) {
          if (lease.lost) result.lost++;
          else if (!shutdown.signal.aborted) throw error;
        } finally {
          lease.dispose();
          if (stopping && !lease.finished) {
            // The provider may already have accepted an interrupted request.
            // Releasing the lease never changes its frozen payload or first attempt.
            const finished = now().toISOString();
            await db.models.email
              .releaseClaim(
                finished,
                new Date(now().getTime() + 60_000).toISOString(),
                row.id,
                row.claim_token,
              )
              .catch(() => {});
          }
        }
      }
      return result;
    } catch (error) {
      if (shutdown.signal.aborted) return result;
      throw error;
    }
  }
  function processQueue(limit = 10) {
    if (activeRun || stopping) return Promise.resolve(emptyResult());
    activeRun = runQueue(limit).finally(() => {
      activeRun = null;
    });
    return activeRun;
  }
  function stop({ graceMs = 20_000 } = {}) {
    if (stopPromise) return stopPromise;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new TypeError('Email shutdown grace must be a nonnegative integer.');
    stopping = true;
    const running = activeRun;
    stopPromise = (async () => {
      if (!running) return;
      let timer;
      try {
        timer = setTimeout(() => shutdown.abort(new EmailWorkerStoppedError()), graceMs);
        await running.catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    })();
    return stopPromise;
  }
  return {
    status,
    get,
    listMessages,
    listReminderMessages,
    enqueueInvoice,
    enqueueReminder,
    enqueuePayment,
    enqueuePasswordReset,
    holdCancelledDocument,
    retry,
    processQueue,
    stop,
  };
}
