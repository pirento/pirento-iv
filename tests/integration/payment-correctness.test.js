/** Integration tests: receipt dates, exact-paise retries and gateway business-date handling. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';

test(
  'MongoDB receipt date, exact-paise retry and both gateway business-date regressions',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    let timestamp = '2026-10-10T18:29:59.999Z';
    const now = () => new Date(timestamp);
    const razorLinks = new Map(),
      razorPayments = new Map(),
      cashLinks = new Map(),
      cashOrders = new Map(),
      cashPayments = new Map();
    let serial = 0;
    const json = (body) => Response.json(structuredClone(body));
    async function paymentFetch(url, init = {}) {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const payload = init.body ? JSON.parse(init.body) : {};
      if (u.hostname === 'api.razorpay.com') {
        if (u.pathname === '/v1/payment_links' && method === 'POST') {
          const link = {
            id: `plink_PHASE1${++serial}`,
            reference_id: payload.reference_id,
            amount: payload.amount,
            amount_paid: 0,
            currency: 'INR',
            status: 'created',
            short_url: `https://rzp.io/phase1${serial}`,
            payments: [],
          };
          razorLinks.set(link.id, link);
          return json(link);
        }
        if (u.pathname.startsWith('/v1/payment_links/'))
          return json(razorLinks.get(u.pathname.split('/').at(-1)));
        if (u.pathname.startsWith('/v1/payments/'))
          return json(razorPayments.get(u.pathname.split('/').at(-1)));
      }
      if (u.hostname === 'sandbox.cashfree.com') {
        if (u.pathname === '/pg/links' && method === 'POST') {
          const link = {
            link_id: payload.link_id,
            link_amount: payload.link_amount,
            link_amount_paid: 0,
            link_currency: 'INR',
            link_status: 'ACTIVE',
            link_url: `https://payments.cashfree.com/links/${payload.link_id}`,
          };
          cashLinks.set(link.link_id, link);
          cashOrders.set(link.link_id, []);
          return json(link);
        }
        if (u.pathname.startsWith('/pg/links/') && u.pathname.endsWith('/orders'))
          return json(cashOrders.get(u.pathname.split('/').at(-2)) ?? []);
        if (u.pathname.startsWith('/pg/links/')) return json(cashLinks.get(u.pathname.split('/').at(-1)));
        if (u.pathname.startsWith('/pg/orders/') && u.pathname.endsWith('/payments'))
          return json(cashPayments.get(u.pathname.split('/').at(-2)) ?? []);
      }
      throw new Error(`Unhandled synthetic provider request: ${method} ${url}`);
    }
    const fixture = await createFixture(t, {
      now,
      auth: false,
      paymentFetch,
      environment: {
        RAZORPAY_KEY_ID: 'rzp_test_phase1',
        RAZORPAY_KEY_SECRET: 'fixture_key',
        RAZORPAY_WEBHOOK_SECRET: 'fixture_webhook',
        EMAIL_AUTOMATION: 'false',
        SHRI_SARRAF_CASHFREE_CLIENT_ID: 'fixture_cashfree_id',
        SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'fixture_cashfree_secret',
        SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
        SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
      },
    });
    const { base, backend } = fixture;
    async function call(path, method = 'GET', body, expected = 200) {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    const recipients = new Map();
    for (const organizationId of ['pipeline2-legal', 'shri-sarraf']) {
      const customer = await call(
        '/customers',
        'POST',
        {
          organizationId,
          name: 'Payment regression recipient',
          email: 'recipient@example.test',
          phone: '9000000000',
          gstin: '',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: '',
        },
        201,
      );
      recipients.set(organizationId, customer.id);
    }
    const invoice = (organizationId = 'pipeline2-legal', rate = 100) =>
      call(
        '/documents',
        'POST',
        {
          organizationId,
          customerId: recipients.get(organizationId),
          kind: 'invoice',
          status: 'sent',
          issueDate: '2026-10-10',
          dueDate: '',
          title: 'Payment regression invoice',
          items: [{ description: 'Fixture service', quantity: 1, rate, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
        201,
      );
    const receipt = (amount, extra = {}) => ({
      amount,
      paidOn: '2026-10-10',
      method: 'bank_transfer',
      reference: 'TEST',
      notes: '',
      requestId: randomUUID(),
      finalizeWhenPaid: true,
      ...extra,
    });

    const manual = await invoice();
    const manualUrl = `/documents/${manual.id}/payments`;
    for (const paidOn of ['2026-10-11', '2199-12-31']) {
      const invalid = await call(manualUrl, 'POST', receipt(100, { paidOn }), 400);
      assert.match(invalid.error, /up to today/);
    }
    await call(
      manualUrl,
      'POST',
      receipt(100, { paidOn: '2199-12-31', providerPaidAt: now().toISOString() }),
      400,
    );
    for (const amount of [0, 1e-9, 0.005, 0.010000001, 1.001])
      await call(manualUrl, 'POST', receipt(amount), 400);
    let details = await call(manualUrl);
    assert.equal(details.payments.length, 0);
    assert.equal(details.document.amountPaid, 0);
    assert.equal(details.document.status, 'sent');
    assert.equal(details.document.finalizedAt, null);
    t.diagnostic('Future dates and fractional-paise receipts leave the ledger and invoice unchanged');

    timestamp = '2026-10-10T18:30:00.000Z';
    const firstPaise = receipt(0.01, { paidOn: '2026-10-11' });
    details = await call(manualUrl, 'POST', firstPaise, 201);
    assert.equal(details.document.amountPaid, 0.01);
    assert.equal(details.payments[0].paidOn, '2026-10-11');
    assert.equal(Object.hasOwn(details.payments[0], 'providerPaidAt'), false);
    timestamp = '2026-10-10T18:29:59.999Z';
    details = await call(manualUrl, 'POST', firstPaise);
    assert.equal(details.payments.length, 1, 'A saved receipt remains retryable if the clock moves back');
    timestamp = '2026-10-11T10:00:00.000Z';
    const decimal = receipt(1.15, { paidOn: '2026-10-01' });
    details = await call(manualUrl, 'POST', decimal, 201);
    const decimalReceipt = details.payments.find((entry) => entry.requestId === decimal.requestId);
    details = await call(manualUrl, 'POST', { ...decimal, amount: 1.1500000000000001 });
    assert.equal(details.payments.length, 2);
    assert.equal(
      details.payments.find((entry) => entry.requestId === decimal.requestId).id,
      decimalReceipt.id,
    );
    await call(manualUrl, 'POST', { ...decimal, amount: 1.14 }, 409);
    details = await call(manualUrl, 'POST', receipt(0.1 + 0.2), 201);
    assert.equal(details.document.amountPaid, 1.46);
    assert.equal(details.payments.find((entry) => entry.amount === 0.3).amount, 0.3);
    assert.equal(
      await backend.db.collection('document_events').countDocuments({
        documentId: manual.id,
        type: 'payment_recorded',
      }),
      3,
    );
    t.diagnostic(
      'India midnight, historical receipt dates and normalized retries retain one exact ledger credit',
    );

    const pennyInvoice = await invoice('pipeline2-legal', 0.01);
    const pennyReceipt = receipt(0.01, { paidOn: '2026-10-11' });
    details = await call(`/documents/${pennyInvoice.id}/payments`, 'POST', pennyReceipt, 201);
    assert.equal(details.document.status, 'paid');
    assert.ok(details.document.finalizedAt);
    assert.equal(details.document.balanceDue, 0);
    details = await call(`/documents/${pennyInvoice.id}/payments`, 'POST', pennyReceipt);
    assert.equal(details.payments.length, 1);
    t.diagnostic('A valid one-paise receipt can finalize an invoice and remains idempotent');

    timestamp = '2026-10-12T19:00:00.000Z';
    const gatewayCases = [
      { instant: '2026-10-10T23:59:59+05:30', expectedDate: '2026-10-10' },
      { instant: '2026-10-11T00:30:00+05:30', expectedDate: '2026-10-11' },
      { instant: undefined, expectedDate: '2026-10-13' },
      { instant: 'invalid-provider-time', expectedError: true },
    ];
    for (const provider of ['razorpay', 'cashfree']) {
      for (const testCase of gatewayCases) {
        const organizationId = provider === 'razorpay' ? 'pipeline2-legal' : 'shri-sarraf';
        const document = await invoice(organizationId);
        const linkResponse = await call(`/documents/${document.id}/payment-link`, 'POST', {});
        if (provider === 'razorpay') {
          const link = razorLinks.get(linkResponse.links[0].providerId);
          const payment = {
            id: `pay_PHASE1${++serial}`,
            amount: 10000,
            currency: 'INR',
            status: 'captured',
            captured: true,
            ...(testCase.instant === undefined
              ? {}
              : {
                  created_at: testCase.expectedError ? testCase.instant : Date.parse(testCase.instant) / 1000,
                }),
          };
          razorPayments.set(payment.id, payment);
          link.amount_paid = 10000;
          link.status = 'paid';
          link.payments.push({ payment_id: payment.id, amount: 10000, status: 'captured' });
        } else {
          const link = cashLinks.get(linkResponse.links[0].referenceId);
          link.link_amount_paid = 100;
          link.link_status = 'PAID';
          const order = {
            order_id: `order_phase1_${++serial}`,
            link_id: link.link_id,
            order_currency: 'INR',
            order_amount: 100,
            order_status: 'PAID',
          };
          cashOrders.set(link.link_id, [order]);
          cashPayments.set(order.order_id, [
            {
              cf_payment_id: `cf_phase1_${serial}`,
              order_id: order.order_id,
              payment_currency: 'INR',
              payment_amount: 100,
              payment_status: 'SUCCESS',
              is_captured: true,
              ...(testCase.instant === undefined ? {} : { payment_completion_time: testCase.instant }),
            },
          ]);
        }
        const sync = () =>
          call(`/documents/${document.id}/payment-link/sync`, 'POST', {}, testCase.expectedError ? 502 : 200);
        const result = await sync();
        details = await call(`/documents/${document.id}/payments`);
        if (testCase.expectedError) {
          assert.match(result.error, /invalid payment timestamp/);
          assert.equal(details.payments.length, 0);
          assert.equal(details.document.amountPaid, 0);
          assert.equal(details.document.finalizedAt, null);
          continue;
        }
        assert.equal(details.payments.length, 1, provider);
        assert.equal(details.payments[0].paidOn, testCase.expectedDate, provider);
        assert.equal(
          details.payments[0].providerPaidAt,
          testCase.instant === undefined ? undefined : new Date(testCase.instant).toISOString(),
          provider,
        );
        assert.equal(details.document.status, 'paid', provider);
        const receiptId = details.payments[0].id;
        await sync();
        details = await call(`/documents/${document.id}/payments`);
        assert.equal(details.payments.length, 1, `${provider} sync retry`);
        assert.equal(details.payments[0].id, receiptId);
      }
      t.diagnostic(
        `${provider}: both sides of India midnight, historical sync, clock fallback, invalid time and sync retry`,
      );
    }
  },
);
