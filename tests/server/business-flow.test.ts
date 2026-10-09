import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import { validGstin } from '../../server/validation/validation.ts';
import type { Mailer } from '../../server/integrations/email/mailer.ts';
import type {
  BusinessDocument,
  Customer,
  DocumentInput,
  Organization,
  PaymentDetails,
} from '../../shared/types.ts';
import type { OnlinePaymentConfiguration, OnlinePaymentDetails } from '../../shared/online-payment-types.ts';
import type { EmailIntegrationStatus, EmailMessage } from '../../shared/messaging-types.ts';
import type { AuthUser } from '../../shared/auth-types.ts';

const LEGAL = 'pipeline2-legal',
  SHRI = 'shri-sarraf';
const NOW = '2026-10-08T12:00:00.000Z';
const sharedEnvironment = {
  RAZORPAY_KEY_ID: 'rzp_test_businessfixture',
  RAZORPAY_KEY_SECRET: 'synthetic-shared-payment-key',
  RAZORPAY_WEBHOOK_SECRET: 'synthetic-shared-webhook',
  RESEND_API_KEY: 're_synthetic_shared',
  EMAIL_FROM: 'Venturecore <billing@venturecore.example>',
  EMAIL_AUTOMATION: 'true',
};
const shriEnvironment = {
  ...sharedEnvironment,
  SHRI_SARRAF_CASHFREE_CLIENT_ID: 'synthetic-shri-client',
  SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'synthetic-shri-secret',
  SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
  SHRI_SARRAF_RESEND_API_KEY: 're_synthetic_shri',
  SHRI_SARRAF_EMAIL_FROM: 'Shri Sarraf <billing@shri.example>',
  SHRI_SARRAF_EMAIL_AUTOMATION: 'true',
};
interface IntegrationStatus {
  payment: OnlinePaymentConfiguration;
  email: EmailIntegrationStatus;
  environmentPrefix: string;
  webhookPath: string;
}
function gst(state: string, pan = 'AAPFU0939F') {
  const prefix = `${state}${pan}1Z`;
  const digit = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((value) => validGstin(prefix + value));
  assert.ok(digit, 'Synthetic registration must have a valid check digit');
  return prefix + digit;
}

async function fixture(t: TestContext, options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const db = initDb(':memory:');
  const app = createApp({
    auth: false,
    db,
    now: () => new Date(NOW),
    environment: {},
    distPath: '/tmp/business-flow-no-dist',
    ...options,
  });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  let cookie = '';
  async function request<T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
    expected = 200,
    session = cookie,
  ): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function login(email: string, password: string) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200, await response.text());
    const session = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session);
    return session;
  }
  async function organization(id = LEGAL) {
    return (await request<Organization[]>('/organizations')).find((org) => org.id === id)!;
  }
  async function saveOrganization(id: string, patch: Partial<Organization>) {
    return request<Organization>(`/organizations/${id}`, 'PUT', { ...(await organization(id)), ...patch });
  }
  async function customer(id = LEGAL, overrides: Partial<Customer> = {}) {
    return request<Customer>(
      '/customers',
      'POST',
      {
        organizationId: id,
        name: 'Synthetic business buyer',
        email: 'buyer@example.test',
        phone: '+91 98765 43210',
        gstin: '',
        address: 'Synthetic buyer address',
        stateCode: '27',
        contactPerson: 'Accounts',
        ...overrides,
      },
      201,
    );
  }
  async function input(id = LEGAL, overrides: Partial<DocumentInput> = {}): Promise<DocumentInput> {
    const buyer = await customer(id);
    return {
      organizationId: id,
      customerId: buyer.id,
      kind: 'invoice',
      status: 'draft',
      issueDate: '2026-10-08',
      dueDate: '2026-11-08',
      title: 'Business flow fixture',
      items: [{ description: 'Synthetic item', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
      discountPercent: 0,
      placeOfSupply: '27',
      notes: '',
      terms: '',
      ...overrides,
    };
  }
  async function taxOrganization(id = LEGAL) {
    return saveOrganization(id, {
      gstin: gst('27'),
      pan: 'AAPFU0939F',
      stateCode: '27',
      address: 'Default Maharashtra address',
      gstRegistrations: [
        {
          id: 'karnataka',
          label: 'Karnataka branch',
          gstin: gst('29'),
          stateCode: '29',
          address: 'Registered Karnataka address',
        },
      ],
    });
  }
  return {
    db,
    app,
    base,
    request,
    login,
    organization,
    saveOrganization,
    customer,
    input,
    taxOrganization,
    setCookie: (value: string) => {
      cookie = value;
    },
    mailer: app.locals.services.mailer as Mailer,
  };
}

test('each organization selects only its own same-PAN GST registration and calculates CGST/SGST or IGST from that registration', async (t) => {
  const f = await fixture(t);
  await f.taxOrganization();
  const input = await f.input(LEGAL, {
    gstRegistrationId: 'karnataka',
    placeOfSupply: '29',
    items: [{ description: 'Taxed fixture', quantity: 1, rate: 1000, gstRate: 18, hsn: '998599' }],
  });
  const local = await f.request<BusinessDocument>('/documents', 'POST', input, 201);
  assert.equal(local.organizationSnapshot.gstin, gst('29'));
  assert.equal(local.organizationSnapshot.address, 'Registered Karnataka address');
  assert.equal(local.organizationSnapshot.stateCode, '29');
  assert.equal(local.gstRegistrationId, 'karnataka');
  assert.deepEqual(
    [local.totals.cgst, local.totals.sgst, local.totals.igst, local.totals.total],
    [90, 90, 0, 1180],
  );
  const interstate = await f.request<BusinessDocument>(
    '/documents',
    'POST',
    { ...input, placeOfSupply: '27' },
    201,
  );
  assert.deepEqual([interstate.totals.cgst, interstate.totals.sgst, interstate.totals.igst], [0, 0, 180]);
  const ordinary = await f.request<BusinessDocument>(
    '/documents',
    'POST',
    { ...input, gstRegistrationId: '', placeOfSupply: '27' },
    201,
  );
  assert.equal(ordinary.organizationSnapshot.gstin, gst('27'));
  assert.equal(ordinary.totals.cgst, 90);
  await f.saveOrganization(SHRI, {
    gstin: gst('09', 'AABCU9603R'),
    pan: 'AABCU9603R',
    stateCode: '09',
    gstRegistrations: [
      {
        id: 'shri-only',
        label: 'Shri branch',
        gstin: gst('29', 'AABCU9603R'),
        stateCode: '29',
        address: 'Independent branch',
      },
    ],
  });
  const rejected = await f.request<{ error: string }>(
    '/documents',
    'POST',
    { ...input, gstRegistrationId: 'shri-only' },
    400,
  );
  assert.match(rejected.error, /registration.*this organization/i);
  const org = await f.organization();
  await f.request(
    `/organizations/${LEGAL}`,
    'PUT',
    {
      ...org,
      gstRegistrations: [
        {
          id: 'other-pan',
          label: 'Different business',
          gstin: gst('29', 'AABCU9603R'),
          stateCode: '29',
          address: '',
        },
      ],
    },
    400,
  );
});

test('drafts can switch saved seller GST; issuing locks the registration and preserves seller details across conversion and delivery', async (t) => {
  const f = await fixture(t);
  const org = await f.taxOrganization();
  const input = await f.input(LEGAL, {
    items: [{ description: 'Taxed fixture', quantity: 1, rate: 1000, gstRate: 18, hsn: '998599' }],
  });
  const draft = await f.request<BusinessDocument>('/documents', 'POST', input, 201);
  const switched = await f.request<BusinessDocument>(`/documents/${draft.id}`, 'PUT', {
    ...input,
    gstRegistrationId: 'karnataka',
  });
  assert.equal(switched.organizationSnapshot.gstin, gst('29'));
  assert.equal(switched.totals.igst, 180);
  const preserved = await f.request<BusinessDocument>(`/documents/${draft.id}`, 'PUT', {
    ...input,
    notes: 'Metadata edit omits the registration field',
  });
  assert.equal(preserved.gstRegistrationId, 'karnataka');
  assert.deepEqual(preserved.organizationSnapshot, switched.organizationSnapshot);
  const reset = await f.request<BusinessDocument>(`/documents/${draft.id}`, 'PUT', {
    ...input,
    gstRegistrationId: '',
  });
  assert.equal(reset.gstRegistrationId || '', '');
  assert.equal(reset.organizationSnapshot.gstin, gst('27'));
  assert.equal(reset.organizationSnapshot.address, 'Default Maharashtra address');
  assert.deepEqual([reset.totals.cgst, reset.totals.sgst, reset.totals.igst], [90, 90, 0]);
  const issued = await f.request<BusinessDocument>(`/documents/${draft.id}`, 'PUT', {
    ...input,
    gstRegistrationId: 'karnataka',
    status: 'sent',
  });
  await f.request(`/documents/${draft.id}`, 'PUT', { ...input, gstRegistrationId: '', status: 'sent' }, 409);
  const quotation = await f.request<BusinessDocument>(
    '/documents',
    'POST',
    { ...input, kind: 'quotation', gstRegistrationId: 'karnataka' },
    201,
  );
  await f.request(`/organizations/${LEGAL}`, 'PUT', {
    ...org,
    name: 'Updated organization name',
    paymentGateway: 'none',
    supportEmail: 'updated@example.test',
    gstRegistrations: [],
  });
  const converted = await f.request<BusinessDocument>(`/documents/${quotation.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(converted.organizationSnapshot, quotation.organizationSnapshot);
  assert.equal(converted.gstRegistrationId, 'karnataka');
  assert.deepEqual(converted.totals, quotation.totals);
  const delivery = await f.request<BusinessDocument>(
    `/documents/${issued.id}/delivery-note`,
    'POST',
    {},
    201,
  );
  assert.deepEqual(delivery.organizationSnapshot, issued.organizationSnapshot);
  assert.equal(delivery.gstRegistrationId, 'karnataka');
  assert.equal(delivery.organizationSnapshot.supportEmail, 'support@pirento.com');
});

test('independent Shri Sarraf does not inherit shared Razorpay, email sender or automatic-email activation', async (t) => {
  const f = await fixture(t, { environment: sharedEnvironment });
  const legal = await f.request<IntegrationStatus>(`/integrations/status?organizationId=${LEGAL}`);
  assert.equal(legal.payment.provider, 'razorpay');
  assert.equal(legal.payment.configured, true);
  assert.equal(legal.email.configured, true);
  const shri = await f.request<IntegrationStatus>(`/integrations/status?organizationId=${SHRI}`);
  assert.equal(shri.payment.provider, 'cashfree');
  assert.equal(shri.payment.configured, false);
  assert.equal(shri.email.configured, false);
  assert.equal(shri.email.from, '');
  assert.equal(shri.email.automationEnabled, false);
  assert.equal(shri.environmentPrefix, 'SHRI_SARRAF');
  assert.equal(shri.webhookPath, '/api/webhooks/cashfree/shri-sarraf');
  const serialized = JSON.stringify(shri);
  for (const value of [
    sharedEnvironment.RAZORPAY_KEY_SECRET,
    sharedEnvironment.RESEND_API_KEY,
    sharedEnvironment.EMAIL_FROM,
  ])
    assert.equal(serialized.includes(value), false);
  const input = await f.input(SHRI, { status: 'sent' });
  const doc = await f.request<BusinessDocument>('/documents', 'POST', input, 201);
  const status = await f.request<OnlinePaymentDetails>(`/documents/${doc.id}/online-payments`);
  assert.equal(status.configuration.provider, 'cashfree');
  assert.equal(status.configuration.configured, false);
  await f.request(`/documents/${doc.id}/payment-link`, 'POST', {}, 503);
});

test('organization-specific Cashfree and email configuration stays separate and document status retains its issued gateway', async (t) => {
  const f = await fixture(t, { environment: shriEnvironment });
  const shri = await f.request<IntegrationStatus>(`/integrations/status?organizationId=${SHRI}`);
  assert.equal(shri.payment.provider, 'cashfree');
  assert.equal(shri.payment.configured, true);
  assert.equal(shri.payment.mode, 'test');
  assert.equal(shri.email.from, shriEnvironment.SHRI_SARRAF_EMAIL_FROM);
  assert.equal(shri.email.configured, true);
  const legal = await f.request<IntegrationStatus>(`/integrations/status?organizationId=${LEGAL}`);
  assert.equal(legal.payment.provider, 'razorpay');
  assert.equal(legal.email.from, sharedEnvironment.EMAIL_FROM);
  const doc = await f.request<BusinessDocument>(
    '/documents',
    'POST',
    await f.input(SHRI, { status: 'sent' }),
    201,
  );
  await f.saveOrganization(SHRI, { paymentGateway: 'none' });
  assert.equal(
    (await f.request<IntegrationStatus>(`/integrations/status?organizationId=${SHRI}`)).payment.provider,
    'none',
  );
  assert.equal(
    (await f.request<IntegrationStatus>(`/integrations/status?organizationId=${SHRI}&documentId=${doc.id}`))
      .payment.provider,
    'cashfree',
  );
  await f.request(`/integrations/status?organizationId=${LEGAL}&documentId=${doc.id}`, 'GET', undefined, 400);
  await f.request(
    `/documents/${doc.id}/payments`,
    'POST',
    {
      amount: 1,
      paidOn: '2026-10-08',
      method: 'cash',
      reference: '',
      notes: '',
      requestId: 'cashfree:fake-receipt',
    },
    400,
  );
});

test('integration status cannot reveal an unassigned organization or pass another organization document as context', async (t) => {
  const owner = { email: 'business-owner@example.test', password: 'Business owner secure test password' };
  const member = {
    email: 'business-member@example.test',
    password: 'Business member secure test password',
    name: 'Business fixture member',
  };
  const f = await fixture(t, {
    auth: {},
    environment: {
      ...shriEnvironment,
      INITIAL_ADMIN_EMAIL: owner.email,
      INITIAL_ADMIN_PASSWORD: owner.password,
    },
  });
  const ownerCookie = await f.login(owner.email, owner.password);
  f.setCookie(ownerCookie);
  const doc = await f.request<BusinessDocument>('/documents', 'POST', await f.input(SHRI), 201);
  await f.request('/auth/signup', 'POST', member, 202, '');
  const users = await f.request<AuthUser[]>('/auth/users');
  const user = users.find((item) => item.email === member.email)!;
  await f.request(`/auth/users/${user.id}`, 'PATCH', {
    role: 'staff',
    status: 'active',
    organizationIds: [LEGAL],
  });
  const memberCookie = await f.login(member.email, member.password);
  await f.request(`/integrations/status?organizationId=${LEGAL}`, 'GET', undefined, 200, memberCookie);
  await f.request(`/integrations/status?organizationId=${SHRI}`, 'GET', undefined, 403, memberCookie);
  await f.request(`/integrations/status?documentId=${doc.id}`, 'GET', undefined, 403, memberCookie);
  await f.request(
    `/integrations/status?organizationId=${LEGAL}&documentId=${doc.id}`,
    'GET',
    undefined,
    403,
    memberCookie,
  );
  await f.request(
    `/integrations/status?organizationId=${LEGAL}&organizationId=${SHRI}`,
    'GET',
    undefined,
    400,
    memberCookie,
  );
});

interface SyntheticLink {
  link_id: string;
  link_amount: number;
  link_amount_paid: number;
  link_currency: string;
  link_status: string;
  link_url: string;
  [key: string]: unknown;
}
interface SyntheticOrder {
  link_id: string;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: string;
}
interface SyntheticPayment {
  cf_payment_id: string;
  order_id: string;
  payment_amount: number;
  payment_currency: string;
  payment_status: string;
  is_captured: boolean;
  payment_completion_time: string;
}
interface DeliveredEmail {
  from: string;
  reply_to: string;
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; content: string }[];
}

test('signed Cashfree callbacks post exact part/final receipts once, lock the invoice and send only Shri Sarraf payment emails', async (t) => {
  const links = new Map<string, SyntheticLink>();
  const orders = new Map<string, SyntheticOrder>();
  const payments = new Map<string, SyntheticPayment[]>();
  const delivered: DeliveredEmail[] = [];
  const providerCalls: string[] = [];
  const paymentFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://sandbox.cashfree.com');
    assert.equal(
      new Headers(init?.headers).get('x-client-id'),
      shriEnvironment.SHRI_SARRAF_CASHFREE_CLIENT_ID,
    );
    assert.equal(
      new Headers(init?.headers).get('x-client-secret'),
      shriEnvironment.SHRI_SARRAF_CASHFREE_CLIENT_SECRET,
    );
    providerCalls.push(`${init?.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/pg/links' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.link_partial_payments, true);
      assert.deepEqual(body.link_notify, { send_sms: false, send_email: false });
      const link: SyntheticLink = {
        ...body,
        cf_link_id: `provider-${links.size}`,
        link_amount_paid: 0,
        link_status: 'ACTIVE',
        link_url: `https://payments.cashfree.com/links/${body.link_id}`,
      };
      links.set(link.link_id, link);
      return Response.json(link);
    }
    const linkMatch = /^\/pg\/links\/([\w-]+)(\/orders)?$/.exec(url.pathname);
    if (linkMatch)
      return Response.json(
        linkMatch[2]
          ? [...orders.values()].filter((order) => order.link_id === linkMatch[1])
          : links.get(linkMatch[1]),
      );
    const order = /^\/pg\/orders\/([\w-]+)\/payments$/.exec(url.pathname)?.[1];
    assert.ok(order && payments.has(order), `Unexpected provider call ${url.pathname}`);
    return Response.json(payments.get(order));
  };
  const emailFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.resend.com/emails');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      `Bearer ${shriEnvironment.SHRI_SARRAF_RESEND_API_KEY}`,
    );
    const email = JSON.parse(String(init?.body)) as DeliveredEmail;
    assert.equal(email.from, shriEnvironment.SHRI_SARRAF_EMAIL_FROM);
    assert.equal(email.reply_to, 'support@shrisarraf.com');
    delivered.push(email);
    return Response.json({ id: `shri-mail-${delivered.length}` });
  };
  const f = await fixture(t, { environment: shriEnvironment, paymentFetch, emailFetch });
  const input = await f.input(SHRI, {
    status: 'sent',
    items: [{ description: 'Synthetic jewellery charge', quantity: 1, rate: 100.01, gstRate: 0, hsn: '' }],
    installmentPlan: {
      name: 'Fixture installments',
      installments: [
        { id: 'first', label: 'First payment', amount: 25.01, dueDate: '2026-10-08' },
        { id: 'last', label: 'Final payment', amount: 75, dueDate: '2026-11-08' },
      ],
    },
  });
  const doc = await f.request<BusinessDocument>('/documents', 'POST', input, 201);
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.equal(links.size, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /https:\/\/payments\.cashfree\.com\/links\//);
  assert.equal(Buffer.from(delivered[0].attachments[0].content, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(delivered[0].text.includes('support@pirento.com'), false);
  const link = [...links.values()][0];
  assert.equal(link.link_amount, 100.01);
  await f.request(
    `/documents/${doc.id}/payments`,
    'POST',
    { amount: 1, paidOn: '2026-10-08', method: 'cash', reference: '', notes: '', requestId: randomUUID() },
    409,
  );
  function addPayment(id: string, amount: number) {
    const orderId = `order_${id}`;
    orders.set(orderId, {
      order_id: orderId,
      link_id: link.link_id,
      order_amount: amount,
      order_currency: 'INR',
      order_status: 'PAID',
    });
    payments.set(orderId, [
      {
        cf_payment_id: id,
        order_id: orderId,
        payment_amount: amount,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        is_captured: true,
        payment_completion_time: NOW,
      },
    ]);
    link.link_amount_paid = Math.round((link.link_amount_paid + amount) * 100) / 100;
    link.link_status = link.link_amount_paid === link.link_amount ? 'PAID' : 'PARTIALLY_PAID';
  }
  async function webhook(eventId: string, badSignature = false) {
    const body = JSON.stringify({
      type: 'PAYMENT_LINK_EVENT',
      data: { link_id: link.link_id, link_status: link.link_status },
    });
    const time = String(Date.parse(NOW));
    const signature = createHmac('sha256', shriEnvironment.SHRI_SARRAF_CASHFREE_CLIENT_SECRET)
      .update(time)
      .update(body)
      .digest('base64');
    const response = await fetch(`${f.base}/api/webhooks/cashfree/${SHRI}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': badSignature ? 'invalid' : signature,
        'x-webhook-timestamp': time,
        'x-idempotency-header': eventId,
      },
      body,
    });
    const result = await response.json();
    assert.equal(response.status, badSignature ? 401 : 200, JSON.stringify(result));
    return result;
  }
  addPayment('first123', 25.01);
  await webhook('invalid-event', true);
  assert.equal((await f.request<PaymentDetails>(`/documents/${doc.id}/payments`)).payments.length, 0);
  await webhook('part-event');
  assert.equal((await webhook('part-event')).duplicate, true);
  const part = await f.request<PaymentDetails>(`/documents/${doc.id}/payments`);
  assert.equal(part.payments.length, 1);
  assert.equal(part.document.status, 'partially_paid');
  assert.equal(part.document.amountPaid, 25.01);
  assert.equal(part.document.balanceDue, 75);
  assert.match(part.payments[0].requestId, /^cashfree:/);
  await f.request(
    `/payments/${part.payments[0].id}/void`,
    'POST',
    { reason: 'Attempted manual void of verified payment' },
    409,
  );
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  addPayment('final456', 75);
  await webhook('final-event');
  await webhook('final-event');
  const final = await f.request<PaymentDetails>(`/documents/${doc.id}/payments`);
  assert.equal(final.payments.length, 2);
  assert.equal(final.document.number, doc.number);
  assert.equal(final.document.status, 'paid');
  assert.equal(final.document.balanceDue, 0);
  assert.equal(final.document.amountPaid, 100.01);
  assert.ok(final.document.finalizedAt);
  await f.request(
    `/documents/${doc.id}`,
    'PUT',
    { ...input, notes: 'Attempted change after settlement' },
    409,
  );
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  const messages = await f.request<EmailMessage[]>(`/documents/${doc.id}/messages`);
  assert.deepEqual(messages.map((message) => message.kind).sort(), [
    'invoice',
    'payment_paid',
    'payment_received',
  ]);
  assert.ok(messages.every((message) => message.status === 'sent'));
  assert.equal(delivered.length, 3);
  assert.equal(providerCalls.filter((call) => call === 'POST /pg/links').length, 1);
  assert.ok(
    delivered.every(
      (email) =>
        email.from === shriEnvironment.SHRI_SARRAF_EMAIL_FROM && email.reply_to === 'support@shrisarraf.com',
    ),
  );
});
