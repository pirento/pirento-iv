/**
 * Email delivery (Resend HTTP API) through a durable outbox.
 *
 * Emails (invoices with PDF attachment, payment receipts, reminders, password resets) are first
 * saved to the email_outbox collection; a worker then claims each message with a 5-minute lease
 * and sends it. Each message keeps one provider idempotency key, so a retry can never send a
 * second copy. Failed sends retry up to 6 times within 23 hours; cancelled documents are held.
 * Per-business sender settings come from src/config/business-config.js.
 */

import { mapAsync } from '../../async-collections.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { balanceDue, DOCUMENT_LABELS } from '../../../../shared/types.js';
import { isIndependentBusiness, organizationFinanceEmail } from '../../../../shared/business-identity.js';
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
// Retry limits: attempts per message, worker lease length, and the window in which a retry is safe.
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
/** Email error with an HTTP status and a message safe to show the user. */
export class EmailQueueError extends Error {
  status;
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = 'EmailQueueError';
  }
}
/** True only for an https:// payment link on a Razorpay or Cashfree host (no login info or custom port). */
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
// Reply-to: the finance email for invoices (and their receipts and reminders), else support.
function replyAddress(org, kind) {
  if (kind !== 'invoice' || !org) return supportAddress(org);
  const finance = organizationFinanceEmail(org).trim();
  return validEmail(finance) ? finance : supportAddress(org);
}
// --- Email content (HTML bodies for each message type) ---
// Emails are short and friendly: a few lines and buttons. Amounts, dates and payment details stay
// in the attached PDF. Layout uses tables and inline styles, which is
// what email apps render reliably.
const safeColor = (...colors) => colors.find((color) => /^#[0-9a-f]{6}$/i.test(color ?? '')) ?? '#0e4d64';
const INK = '#13303b';
const MUTED = '#5c6b73';
const LINE = '#e6ddd4';
const COMPANY = 'Venturecore Solutions Private Limited';

/**
 * The look of one business's emails: its brand colour (Business settings → Accent colour) and
 * accent stripe, logo (served from /brand/<id>/logo when PUBLIC_APP_URL is set, since email apps
 * block images embedded in the message), name, and the address customers write to (finance for
 * invoices and receipts, support otherwise).
 */
function brandOf(org, { origin, kind } = {}) {
  if (!org)
    return {
      color: '#0e4d64',
      accent: '#bb4b2c',
      name: COMPANY,
      legal: '',
      logo: '',
      footer: [],
      contact: 'support@pirento.com',
    };
  const name = org.tradeName || org.name;
  const color = safeColor(org.accentColor);
  return {
    color,
    accent: safeColor(org.brandAccent, color),
    name,
    legal: org.legalName && org.legalName !== name ? legalIdentity(org) : '',
    logo: /^https:\/\//.test(org.logoUrl ?? '')
      ? org.logoUrl
      : origin && org.id && /^(data:image\/|stored-image:)/.test(org.logoUrl ?? '')
        ? `${origin}/brand/${encodeURIComponent(org.id)}/logo`
        : '',
    logoSize: logoSize(org.logoUrl),
    footer: [org.address, [org.gstin && `GSTIN ${org.gstin}`, org.phone].filter(Boolean).join(' · ')].filter(
      Boolean,
    ),
    contact: replyAddress(org, kind),
  };
}

// Display size of a logo inside 260 × 64, from a PNG's own width and height (others: 52 high).
function logoSize(dataUrl = '') {
  const png = /^data:image\/png;base64,/.test(dataUrl) && Buffer.from(dataUrl.slice(22, 70), 'base64');
  const width = png && png.length >= 24 ? png.readUInt32BE(16) : 0;
  const height = png && png.length >= 24 ? png.readUInt32BE(20) : 0;
  if (!width || !height) return { width: 0, height: 52 };
  const scale = Math.min(260 / width, 64 / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function emailFrame({ title, preheader = '', brand, body }) {
  const { color } = brand;
  const header = brand.logo
    ? `<img src="${escaped(brand.logo)}" alt="${escaped(brand.name)}"${brand.logoSize.width ? ` width="${brand.logoSize.width}"` : ''} height="${brand.logoSize.height}" style="display:block;margin:0 auto;${brand.logoSize.width ? `width:${brand.logoSize.width}px;` : ''}height:${brand.logoSize.height}px;max-width:100%;border:0">`
    : `<div style="font-size:22px;font-weight:bold;line-height:1.3;color:${color}">${escaped(brand.name)}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media only screen and (max-width:480px){.m-pad{padding-left:20px!important;padding-right:20px!important}.m-btn{display:block!important;padding:6px 0!important}}</style><title>${escaped(title)}</title></head><body style="margin:0;padding:0;background:#f4efe9;color:${INK};font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escaped(preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4efe9"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${LINE}"><tr><td style="height:6px;line-height:6px;font-size:0;background:${brand.accent}">&nbsp;</td></tr><tr><td class="m-pad" align="center" style="padding:30px 36px 0;text-align:center">${header}${brand.legal ? `<div style="margin-top:8px;font-size:12px;line-height:1.5;color:${MUTED}">${escaped(brand.legal)}</div>` : ''}</td></tr><tr><td class="m-pad" align="center" style="padding:26px 36px 32px;text-align:center;font-size:15px;line-height:1.65"><h1 style="margin:0 0 18px;font-size:23px;line-height:1.3;color:${color}">${escaped(title)}</h1>${body}<p style="margin:26px 0 0;color:${MUTED}">Warm regards,<br><strong style="color:${INK}">${escaped(brand.name)}</strong></p></td></tr><tr><td class="m-pad" align="center" style="padding:18px 36px 22px;background:#faf6f2;border-top:1px solid ${LINE};text-align:center;font-size:12px;line-height:1.6;color:${MUTED}">${brand.footer.map((line) => textLines(line)).join('<br>')}${brand.footer.length ? '<br>' : ''}Questions? Write to <a href="mailto:${escaped(brand.contact)}" style="color:${color}">${escaped(brand.contact)}</a> or simply reply to this email.</td></tr></table></td></tr></table></body></html>`;
}
const textFooter = (brand) =>
  [
    'Warm regards,',
    brand.name,
    '',
    ...brand.footer,
    `Questions? Write to ${brand.contact} or simply reply to this email.`,
  ].join('\n');

// A reply to the business with the subject filled in, e.g. for "Accept quotation".
const mailto = (brand, subject) => `mailto:${brand.contact}?subject=${encodeURIComponent(subject)}`;

/**
 * One email body, HTML and text: a greeting, a few friendly lines, buttons and the attached-PDF
 * note. Amounts, dates and payment details stay in the attached PDF.
 */
function compose(brand, { title, name, lines = [], buttons = [], attached }) {
  const para = (line) => `<p style="margin:0 0 12px">${escaped(line)}</p>`;
  const button = ({ label, href, primary }) =>
    `<td class="m-btn" style="padding:6px"><a href="${escaped(href)}" style="display:inline-block;padding:13px 26px;border-radius:999px;font-weight:bold;font-size:15px;text-decoration:none;${primary ? `background:${brand.color};color:#ffffff;border:2px solid ${brand.color}` : `background:#ffffff;color:${brand.color};border:2px solid ${brand.color}`}">${escaped(label)}</a></td>`;
  const html = `<p style="margin:0 0 12px">Dear ${escaped(name)},</p>${lines.map(para).join('')}${attached ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:18px auto 6px"><tr><td style="padding:10px 18px;border-radius:999px;background:#f4f1ec;font-size:14px;color:${INK}">&#128206;&nbsp; ${escaped(attached)}</td></tr></table>` : ''}${buttons.length ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:14px auto 0"><tr>${buttons.map(button).join('')}</tr></table>` : ''}`;
  const text = [
    title,
    '',
    `Dear ${name},`,
    ...lines,
    '',
    attached ? `Attached: ${attached}` : '',
    ...buttons.map(({ label, href }) => `${label}: ${href.replace(/^mailto:([^?]+).*/, '$1')}`),
    '',
    textFooter(brand),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { html, text };
}

// What the document is called in emails: Tax invoice (with the seller's GSTIN), Invoice, Debit note, ...
function documentName(doc) {
  if (doc.debitNoteFor) return 'Debit note';
  if (doc.kind === 'invoice') return doc.organizationSnapshot?.gstin ? 'Tax invoice' : 'Invoice';
  return DOCUMENT_LABELS[doc.kind];
}
const lower = (label) => label.charAt(0).toLowerCase() + label.slice(1);
const businessName = (doc) => doc.organizationSnapshot.tradeName || doc.organizationSnapshot.name;
const payOnline = (url) => (url ? [{ label: 'Pay online', href: url, primary: true }] : []);

/** Subject line of a document email, e.g. "Tax invoice ATEI/2627/0001 from A T Elevator". */
function documentSubject(doc) {
  const head = `${documentName(doc)} ${doc.number} from ${businessName(doc)}`;
  return doc.kind === 'invoice' && balanceDue(doc) <= 0 ? `${head} · Paid` : head;
}

/** The email for a document: invoice, debit note, quotation or proforma invoice (challans are not emailed). */
function documentEmail(doc, paymentUrl, brand) {
  const name = documentName(doc);
  const label = lower(name);
  const title = `${name} ${doc.number}`;
  const customer = doc.customerSnapshot.name;
  const attached = `${name} ${doc.number} (PDF)`;
  const reply = (text, subject = title) => ({ label: text, href: mailto(brand, subject) });
  if (doc.kind === 'quotation')
    return compose(brand, {
      title,
      name: customer,
      lines: [
        `Thank you for your interest in ${brand.name}. Please find our quotation ${doc.number} attached — it has the full scope, prices and terms.`,
        'If it looks good, just tap “Accept quotation” and we will take it from there. Happy to answer any questions too.',
      ],
      attached,
      buttons: [
        { ...reply('Accept quotation', `Accepting quotation ${doc.number}`), primary: true },
        reply('Ask a question', `Question about quotation ${doc.number}`),
      ],
    });
  if (doc.kind === 'proforma')
    return compose(brand, {
      title,
      name: customer,
      lines: [
        `Please find your proforma invoice ${doc.number} attached. The amount and payment details are in the PDF.`,
        'Once the payment is received, we will send the tax invoice.',
      ],
      attached,
      buttons: [reply('Reply to us')],
    });
  // Invoices and debit notes.
  const due = balanceDue(doc);
  if (due <= 0)
    return compose(brand, {
      title,
      name: customer,
      lines: [
        `Thank you! Your ${label} ${doc.number} is fully paid.`,
        'A copy is attached for your records.',
      ],
      attached,
      buttons: [reply('Reply to us')],
    });
  const paidSome = doc.totals.total - due > 0;
  return compose(brand, {
    title,
    name: customer,
    lines: [
      doc.debitNoteFor
        ? `Please find attached debit note ${doc.number}, raised against invoice ${doc.debitNoteFor.number}.`
        : paidSome
          ? `Thank you for your payment so far. Please find your updated ${label} ${doc.number} attached.`
          : `Thank you for choosing ${brand.name}. Please find your ${label} ${doc.number} attached.`,
      'The amount, due date and payment details are all in the PDF.',
    ],
    attached,
    buttons: [...payOnline(paymentUrl), { ...reply('Reply to us'), primary: !paymentUrl }],
  });
}

function invoicePayload(doc, paymentUrl, origin) {
  validatePaymentUrl(paymentUrl, doc.organizationSnapshot);
  const brand = brandOf(doc.organizationSnapshot, { origin, kind: doc.kind });
  const title = `${documentName(doc)} ${doc.number}`;
  const email = documentEmail(
    doc,
    doc.kind === 'invoice' && balanceDue(doc) > 0 ? paymentUrl : undefined,
    brand,
  );
  return {
    organizationId: doc.organizationId,
    html: emailFrame({ title, preheader: documentSubject(doc), brand, body: email.html }),
    text: email.text,
    document: doc,
  };
}

function paymentReminderPayload(document, reminder, asOf, origin) {
  const target = reminderTargets(document, asOf).find(
    (item) => item.installmentId === reminder.installmentId,
  );
  if (!target || target.dueDate !== reminder.dueDate)
    throw new EmailQueueError('This payment reminder no longer matches an unpaid due amount.', 409);
  const name = lower(documentName(document));
  const [title, line] =
    target.status === 'overdue'
      ? [
          'A gentle reminder',
          `Our records show that the payment for ${name} ${document.number} is now past its due date. We would be grateful if you could arrange it at your earliest convenience.`,
        ]
      : target.status === 'due_today'
        ? [
            'Payment due today',
            `A quick reminder that the payment for ${name} ${document.number} is due today.`,
          ]
        : [
            'Upcoming payment',
            `A friendly reminder that the payment for ${name} ${document.number} is coming up soon.`,
          ];
  const brand = brandOf(document.organizationSnapshot, { origin, kind: document.kind });
  const email = compose(brand, {
    title,
    name: document.customerSnapshot.name,
    lines: [
      line,
      'The invoice is attached again with the amount and payment details. If you have already paid, thank you — just let us know.',
    ],
    attached: `${documentName(document)} ${document.number} (PDF)`,
    buttons: [
      {
        label: 'I have already paid',
        href: mailto(brand, `Payment made for ${name} ${document.number}`),
        primary: true,
      },
      { label: 'Reply to us', href: mailto(brand, `${documentName(document)} ${document.number}`) },
    ],
  });
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
    html: emailFrame({ title, preheader: line, brand, body: email.html }),
    text: email.text,
  };
}
/**
 * Creates the mailer. Returns { status, get, listMessages, listReminderMessages, enqueueInvoice,
 * enqueueReminder, enqueuePayment, enqueuePasswordReset, holdCancelledDocument, retry,
 * processQueue (the worker loop), stop }.
 */
export function createMailer(db, options = {}) {
  const env = options.env ?? process.env,
    fetcher = options.fetch ?? fetch,
    smtpSend =
      options.smtpSend ??
      ((smtp, message) =>
        nodemailer
          .createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
          })
          .sendMail(message)),
    now = options.now ?? (() => new Date());
  // Address of this app, for business logos in emails (blank when PUBLIC_APP_URL is not set).
  const publicOrigin = URL.canParse(env.PUBLIC_APP_URL ?? '') ? new URL(env.PUBLIC_APP_URL).origin : '';
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
  // --- Worker claims and leases ---
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
  // --- Sender configuration per business ---
  async function configuration(organizationId, snapshot) {
    const org = organizationId
      ? options.getOrganization
        ? await options.getOrganization(organizationId)
        : snapshot
      : undefined;
    const missing = Boolean(organizationId && (!org || org.id !== organizationId));
    const saved = org && options.integrationSettings ? await options.integrationSettings(org.id) : {};
    const scoped = org ? organizationEnvironment(org, env, saved) : organizationId ? {} : env;
    const own = (scoped.EMAIL_FROM ?? '').trim();
    // A bare address is sent with the business name, e.g. "A T Elevator" <billing@...>.
    const from =
      org && validEmail(own)
        ? `"${(org.tradeName || org.name || '').replace(/["<>\r\n]/g, '')}" <${own}>`
        : own;
    const address = from.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/)?.[1] ?? from;
    const apiKey = (scoped.RESEND_API_KEY ?? '').trim();
    // An SMTP server (host set) replaces the Resend API for this business.
    const smtp = scoped.SMTP_HOST?.trim()
      ? {
          host: scoped.SMTP_HOST.trim(),
          port: Number(scoped.SMTP_PORT) || (scoped.SMTP_SECURE === 'true' ? 465 : 587),
          secure: scoped.SMTP_SECURE === 'true',
          user: (scoped.SMTP_USER ?? '').trim(),
          pass: scoped.SMTP_PASSWORD ?? '',
        }
      : null;
    const configured = !missing && Boolean(smtp || apiKey) && !/[\r\n]/.test(from) && validEmail(address);
    const credentials = smtp ? `smtp:${smtp.host}:${smtp.port}:${smtp.user}:${smtp.pass}` : apiKey;
    const integration = {
      configured,
      provider: smtp ? 'smtp' : 'resend',
      from,
      organizationId,
      replyTo: supportAddress(org),
      automationEnabled: scoped.EMAIL_AUTOMATION === 'true',
      reason: configured
        ? ''
        : missing
          ? 'The issuing organization is unavailable. Restore its email configuration before retrying.'
          : 'Email sending is not configured for this business. Add its sender address and SMTP server or Resend API key on the Payments & email page.',
    };
    return {
      integration,
      apiKey,
      smtp,
      profile: {
        organizationId,
        businessType: org && isIndependentBusiness(org) ? 'independent' : 'division',
        keyFingerprint: credentials ? createHash('sha256').update(credentials).digest('hex') : '',
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
    resolved.profile.replyTo = replyAddress(payload.document?.organizationSnapshot, payload.document?.kind);
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
  // --- Reading messages for the UI ---
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
  // --- Queueing messages ---
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
    return await enqueue(
      'invoice',
      doc.customerSnapshot.email,
      documentSubject(doc),
      {
        ...invoicePayload(doc, input.paymentUrl, publicOrigin),
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
      paymentReminderPayload(document, reminder, indiaBusinessDate(now()), publicOrigin),
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
    const brand = brandOf(doc.organizationSnapshot, { origin: publicOrigin, kind: doc.kind });
    const name = documentName(doc);
    const label = `${lower(name)} ${doc.number}`;
    const reply = { label: 'Reply to us', href: mailto(brand, `${name} ${doc.number}`) };
    const url = balanceDue(doc) > 0 ? input.paymentUrl : undefined;
    const [title, subject, lines, buttons, attached] =
      outcome === 'failed'
        ? [
            'Payment not completed',
            `Payment unsuccessful · ${name} ${doc.number} · ${businessName(doc)}`,
            [
              `Your online payment for ${label} did not go through, so nothing has been recorded against it.`,
              'If money was debited from your account, your bank usually returns it within 5–7 working days. You are welcome to try again, or reply to us if you need help.',
            ],
            [...(url ? [{ label: 'Try again', href: url, primary: true }] : []), { ...reply, primary: !url }],
            `${name} ${doc.number} (PDF)`,
          ]
        : outcome === 'paid'
          ? [
              'Thank you for your payment',
              `Payment received · ${name} ${doc.number} fully paid · ${businessName(doc)}`,
              [
                `We have received your payment, and ${label} is now fully paid.`,
                'Thank you for your business — the paid invoice is attached for your records.',
              ],
              [reply],
              `Paid ${lower(name)} ${doc.number} (PDF)`,
            ]
          : [
              'Thank you for your payment',
              `Payment received · ${name} ${doc.number} · ${businessName(doc)}`,
              [
                `We have received your payment against ${label}. Thank you!`,
                'The updated invoice, with the balance and payment details, is attached.',
              ],
              [...payOnline(url), { ...reply, primary: !url }],
              `Updated ${lower(name)} ${doc.number} (PDF)`,
            ];
    const email = compose(brand, { title, name: doc.customerSnapshot.name, lines, buttons, attached });
    return await enqueue(
      outcome === 'failed' ? 'payment_failed' : outcome === 'paid' ? 'payment_paid' : 'payment_received',
      doc.customerSnapshot.email,
      subject,
      {
        organizationId: doc.organizationId,
        html: emailFrame({ title, preheader: subject, brand, body: email.html }),
        text: email.text,
        document: doc,
      },
      input.eventKey,
      doc.id,
      Boolean(url),
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
    const title = 'Reset your password';
    const brand = brandOf(null);
    const email = compose(brand, {
      title,
      name: input.name,
      lines: [
        'We received a request to reset your password. The button below is valid for 30 minutes and can be used once.',
        'If you did not ask for this, you can ignore this email — your password stays the same.',
      ],
      buttons: [{ label: 'Reset password', href: url.href, primary: true }],
    });
    return await enqueue(
      'password_reset',
      input.to,
      title,
      {
        html: emailFrame({
          title,
          preheader: 'Choose a new password within 30 minutes.',
          brand,
          body: email.html,
        }),
        text: email.text,
        expiresAt: new Date(now().getTime() + 30 * 60_000).toISOString(),
      },
      input.eventKey,
      null,
    );
  }
  // --- Retry and delivery (worker) ---
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
              ...paymentReminderPayload(document, payload.reminder, preparedOn, publicOrigin),
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
          payload = invoicePayload(resolved.document, resolved.paymentUrl, publicOrigin);
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
      const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(config.smtp ? 30_000 : 15_000)]);
      if (config.smtp) {
        // shortcut: SMTP has no idempotency key, so a retry after a lost server reply can send twice.
        try {
          const info = await abortable(
            () =>
              smtpSend(config.smtp, {
                from: payload.sender,
                replyTo: payload.senderProfile.replyTo,
                to: row.recipient,
                subject: row.subject,
                html: payload.html,
                text: payload.text,
                headers: { 'X-Entity-Ref-ID': 'venturecore-email/' + row.id },
                attachments: payload.attachment
                  ? [
                      {
                        filename: payload.attachment.filename,
                        content: Buffer.from(payload.attachment.content, 'base64'),
                      },
                    ]
                  : [],
              }),
            signal,
          );
          acceptedId = String(info?.messageId || 'smtp-accepted').slice(0, 200);
        } catch (error) {
          lease.signal.throwIfAborted();
          // 5xx replies (bad login, rejected sender or recipient) will not succeed on retry.
          retryable = !(error?.responseCode >= 500);
          failure = retryable
            ? 'The SMTP server could not be reached. Delivery will be retried.'
            : `The SMTP server rejected this message (${error.responseCode}). Check the SMTP login, sender and recipient.`;
        }
      } else {
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
  /**
   * Sends one test email for a business straight away (not queued), with its saved sender, reply-to,
   * look and transport, so an administrator can check its email settings. Throws with the reason.
   */
  async function sendTest(organizationId, to) {
    if (!validEmail(String(to ?? ''))) throw new EmailQueueError('Enter a valid email address for the test.');
    const config = await configuration(organizationId);
    if (!config.integration.configured) throw new EmailQueueError(config.integration.reason, 409);
    const org = await options.getOrganization(organizationId);
    const brand = brandOf(org, { origin: publicOrigin, kind: 'invoice' });
    const title = 'Your email is ready';
    const email = compose(brand, {
      title,
      name: `${brand.name} team`,
      lines: [
        `This is a test email for ${brand.name}. Invoices, quotations, receipts and reminders to your customers will look like this, with the document attached as a PDF.`,
        `Replies about invoices and payments go to ${brand.contact}.`,
      ],
      buttons: [{ label: 'Reply to us', href: mailto(brand, 'Test email'), primary: true }],
    });
    const message = {
      from: config.integration.from,
      replyTo: brand.contact,
      to,
      subject: `Test email from ${brand.name}`,
      html: emailFrame({ title, preheader: 'Your business email settings work.', brand, body: email.html }),
      text: email.text,
    };
    try {
      if (config.smtp) await smtpSend(config.smtp, { ...message, attachments: [] });
      else {
        const response = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...message, reply_to: message.replyTo, to: [to], replyTo: undefined }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { provider: true });
      }
    } catch (error) {
      throw new EmailQueueError(
        `The test email was not sent: ${config.smtp ? 'the SMTP server said' : 'Resend said'} “${String(error?.message ?? error).slice(0, 200)}”. Check the settings above.`,
        502,
      );
    }
    return {
      sent: true,
      from: message.from,
      replyTo: message.replyTo,
      provider: config.integration.provider,
    };
  }
  return {
    sendTest,
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
