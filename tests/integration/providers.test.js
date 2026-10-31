/** Integration tests: Razorpay/Cashfree links, signed webhooks, idempotency and invoice email. */

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';

test(
  'MongoDB gateway verification, idempotency and durable invoice email',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    const env = {
      RAZORPAY_KEY_ID: 'rzp_test_fixture',
      RAZORPAY_KEY_SECRET: 'fixture_key',
      RAZORPAY_WEBHOOK_SECRET: 'fixture_webhook',
      RESEND_API_KEY: 'fixture_resend',
      EMAIL_FROM: 'Venturecore <billing@example.test>',
      EMAIL_AUTOMATION: 'false',
      SHRI_SARRAF_CASHFREE_CLIENT_ID: 'fixture_cf_id',
      SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'fixture_cf_secret',
      SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
      SHRI_SARRAF_RESEND_API_KEY: 'fixture_shri_resend',
      SHRI_SARRAF_EMAIL_FROM: 'Shri Sarraf <billing@independent.example.test>',
      SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
    };
    const razorLinks = new Map(),
      razorPayments = new Map(),
      cashLinks = new Map(),
      cashOrders = new Map(),
      cashPayments = new Map(),
      emails = [];
    let serial = 0,
      unknownRazor = false,
      unknownCash = false,
      emailFail = false;
    let paymentRendezvous;
    const json = (body) => Response.json(structuredClone(body));
    async function paymentFetch(url, init = {}) {
      const u = new URL(url),
        method = init.method ?? 'GET',
        payload = init.body ? JSON.parse(init.body) : {};
      if (u.hostname === 'api.razorpay.com') {
        if (u.pathname === '/v1/payment_links' && method === 'POST') {
          const link = {
            id: 'plink_TEST' + ++serial,
            reference_id: payload.reference_id,
            amount: payload.amount,
            amount_paid: 0,
            currency: 'INR',
            status: 'created',
            short_url: 'https://rzp.io/test' + serial,
            payments: [],
            notes: payload.notes,
          };
          razorLinks.set(link.id, link);
          if (unknownRazor) {
            unknownRazor = false;
            throw new Error('Test network interruption');
          }
          return json(link);
        }
        if (u.pathname === '/v1/payment_links')
          return json({
            payment_links: [...razorLinks.values()].filter((l) =>
              u.searchParams.has('reference_id')
                ? l.reference_id === u.searchParams.get('reference_id')
                : l.payments.some((p) => p.payment_id === u.searchParams.get('payment_id')),
            ),
          });
        if (u.pathname.endsWith('/cancel')) {
          const id = u.pathname.split('/').at(-2),
            link = razorLinks.get(id);
          link.status = 'cancelled';
          return json(link);
        }
        if (u.pathname.startsWith('/v1/payment_links/'))
          return json(razorLinks.get(u.pathname.split('/').at(-1)));
        if (u.pathname.startsWith('/v1/payments/')) {
          if (paymentRendezvous) await paymentRendezvous();
          return json(razorPayments.get(u.pathname.split('/').at(-1)));
        }
      }
      if (u.hostname === 'sandbox.cashfree.com') {
        assert.equal(init.headers['x-client-id'], env.SHRI_SARRAF_CASHFREE_CLIENT_ID);
        if (u.pathname === '/pg/links' && method === 'POST') {
          const link = {
            link_id: payload.link_id,
            link_amount: payload.link_amount,
            link_amount_paid: 0,
            link_currency: 'INR',
            link_status: 'ACTIVE',
            link_url: 'https://payments.cashfree.com/links/' + payload.link_id,
          };
          cashLinks.set(link.link_id, link);
          cashOrders.set(link.link_id, []);
          if (unknownCash) {
            unknownCash = false;
            throw new Error('Test network interruption');
          }
          return json(link);
        }
        if (u.pathname.endsWith('/cancel')) {
          const id = u.pathname.split('/').at(-2),
            link = cashLinks.get(id);
          link.link_status = 'CANCELLED';
          return json(link);
        }
        if (u.pathname.startsWith('/pg/links/') && u.pathname.endsWith('/orders'))
          return json(cashOrders.get(u.pathname.split('/').at(-2)) ?? []);
        if (u.pathname.startsWith('/pg/links/')) return json(cashLinks.get(u.pathname.split('/').at(-1)));
        if (u.pathname.startsWith('/pg/orders/') && u.pathname.endsWith('/payments'))
          return json(cashPayments.get(u.pathname.split('/').at(-2)) ?? []);
      }
      throw new Error('Unhandled mock provider request ' + method + ' ' + url);
    }
    async function emailFetch(url, init) {
      assert.equal(url, 'https://api.resend.com/emails');
      emails.push({ headers: init.headers, body: JSON.parse(init.body) });
      if (emailFail) return Response.json({ message: 'retry' }, { status: 503 });
      return json({ id: 'sent_' + emails.length });
    }
    const fixture = await createFixture(t, { environment: env, auth: false, paymentFetch, emailFetch });
    const { backend, base } = fixture;
    async function call(path, method = 'GET', body, expected = 200) {
      const res = await fetch(base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    async function webhook(provider, org, event, id = 'event' + serial, bad = false, host = base) {
      const body = JSON.stringify(event),
        headers = { 'Content-Type': 'application/json' };
      if (provider === 'razorpay') {
        headers['x-razorpay-signature'] = bad
          ? '0'.repeat(64)
          : createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
        headers['x-razorpay-event-id'] = id;
      } else {
        const timestamp = String(Date.now());
        headers['x-webhook-timestamp'] = timestamp;
        headers['x-webhook-signature'] = bad
          ? '0'.repeat(43) + '='
          : createHmac('sha256', env.SHRI_SARRAF_CASHFREE_CLIENT_SECRET)
              .update(timestamp)
              .update(body)
              .digest('base64');
        headers['x-idempotency-header'] = id;
      }
      const response = await fetch(host + '/api/webhooks/' + provider + '/' + org, {
        method: 'POST',
        headers,
        body,
      });
      return { status: response.status, data: await response.json() };
    }
    const input = (org, c) => ({
      organizationId: org,
      customerId: c,
      kind: 'invoice',
      status: 'sent',
      issueDate: '2026-10-10',
      dueDate: '',
      title: 'Invoice',
      items: [{ description: 'Fixture service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    });
    const paid = (amount) => ({
      amount,
      paidOn: '2026-10-10',
      method: 'upi',
      reference: 'offline',
      notes: '',
      requestId: randomUUID(),
    });
    let passed = 0;
    const check = (name) => {
      passed++;
      t.diagnostic(name);
    };
    const orgs = await call('/organizations'),
      legal = orgs.find((x) => x.id === 'pipeline2-legal'),
      shri = orgs.find((x) => x.id === 'shri-sarraf');
    const contact = (org) => ({
      organizationId: org,
      name: 'Recipient',
      email: 'recipient@example.test',
      phone: '9000000000',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    });
    const lc = await call('/customers', 'POST', contact(legal.id), 201),
      sc = await call('/customers', 'POST', contact(shri.id), 201);
    assert.equal(
      (await call('/integrations/status?organizationId=' + legal.id)).payment.provider,
      'razorpay',
    );
    assert.equal((await call('/integrations/status?organizationId=' + shri.id)).payment.provider, 'cashfree');
    check('Per-business Razorpay/Cashfree credentials remain isolated');
    const inv = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    let links = await call('/documents/' + inv.id + '/payment-link', 'POST', {});
    assert.equal(links.links[0].state, 'created');
    assert.equal(links.links[0].amount, 100);
    await call('/documents/' + inv.id + '/payments', 'POST', paid(10), 409);
    check('Razorpay link creation blocks offline ledger changes');
    const link = razorLinks.get(links.links[0].providerId);
    const payment = {
      id: 'pay_TEST1',
      amount: 10000,
      currency: 'INR',
      status: 'captured',
      captured: true,
      created_at: Math.floor(Date.now() / 1000),
    };
    razorPayments.set(payment.id, payment);
    link.amount_paid = 10000;
    link.status = 'paid';
    link.payments.push({ payment_id: payment.id, amount: 10000, status: 'captured' });
    const event = {
      event: 'payment.captured',
      payload: {
        payment_link: { entity: { id: link.id, reference_id: link.reference_id } },
        payment: { entity: { id: payment.id } },
      },
    };
    assert.equal((await webhook('razorpay', legal.id, event, 'rp1', true)).status, 401);
    let response = await webhook('razorpay', legal.id, event, 'rp1');
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal((await webhook('razorpay', legal.id, event, 'rp1')).data.duplicate, true);
    assert.equal((await webhook('razorpay', legal.id, { ...event, extra: true }, 'rp1')).status, 409);
    let receipts = await call('/documents/' + inv.id + '/payments');
    assert.equal(receipts.payments.length, 1);
    assert.equal(receipts.document.amountPaid, 100);
    assert.equal(receipts.document.status, 'paid');
    await call(
      '/payments/' + receipts.payments[0].id + '/void',
      'POST',
      { reason: 'cannot void provider receipt' },
      409,
    );
    check('Signed Razorpay webhooks verify provider amounts, deduplicate and finalize');
    const cancelInv = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    await call('/documents/' + cancelInv.id + '/payment-link', 'POST', {});
    const cancelled = await call('/documents/' + cancelInv.id + '/payment-link/cancel', 'POST', {});
    assert.equal(cancelled.links[0].state, 'cancelled');
    await call('/documents/' + cancelInv.id + '/payments', 'POST', paid(10), 201);
    check('Confirmed provider cancellation releases manual payment entry');
    const uncertain = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    unknownRazor = true;
    await call('/documents/' + uncertain.id + '/payment-link', 'POST', {}, 502);
    let uncertainState = await call('/documents/' + uncertain.id + '/online-payments');
    assert.equal(uncertainState.links[0].state, 'creation_unknown');
    const count = razorLinks.size;
    uncertainState = await call('/documents/' + uncertain.id + '/payment-link', 'POST', {});
    assert.equal(uncertainState.links.length, 1);
    assert.equal(razorLinks.size, count);
    assert.equal(uncertainState.links[0].state, 'created');
    check('Uncertain Razorpay creation reconciles saved reference without duplicate link');
    const cfInv = await call('/documents', 'POST', input(shri.id, sc.id), 201);
    const cfDetails = await call('/documents/' + cfInv.id + '/payment-link', 'POST', {});
    const cfLink = cashLinks.get(cfDetails.links[0].referenceId);
    cfLink.link_amount_paid = 100;
    cfLink.link_status = 'PAID';
    const order = {
      order_id: 'order_fixture1',
      link_id: cfLink.link_id,
      order_currency: 'INR',
      order_amount: 100,
      order_status: 'PAID',
    };
    cashOrders.set(cfLink.link_id, [order]);
    cashPayments.set(order.order_id, [
      {
        cf_payment_id: '1001',
        order_id: order.order_id,
        payment_currency: 'INR',
        payment_amount: 100,
        payment_status: 'SUCCESS',
        is_captured: true,
        payment_completion_time: new Date().toISOString(),
      },
    ]);
    const cfEvent = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { link_id: cfLink.link_id, order: { order_id: order.order_id } },
    };
    assert.equal((await webhook('cashfree', shri.id, cfEvent, 'cf1', true)).status, 401);
    response = await webhook('cashfree', shri.id, cfEvent, 'cf1');
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal((await webhook('cashfree', shri.id, cfEvent, 'cf1')).data.duplicate, true);
    receipts = await call('/documents/' + cfInv.id + '/payments');
    assert.equal(receipts.payments.length, 1);
    assert.equal(receipts.document.status, 'paid');
    check('Cashfree order membership, signature and single ledger credit');
    const badInv = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    const badLinks = await call('/documents/' + badInv.id + '/payment-link', 'POST', {});
    razorLinks.get(badLinks.links[0].providerId).amount = 9999;
    await call('/documents/' + badInv.id + '/payment-link/sync', 'POST', {}, 409);
    assert.equal((await call('/documents/' + badInv.id + '/online-payments')).links[0].state, 'needs_review');
    assert.equal((await call('/documents/' + badInv.id + '/payments')).payments.length, 0);
    check('Mismatched provider amount held for review without credit');
    const msg = await call(
      '/documents/' + inv.id + '/email',
      'POST',
      { requestId: randomUUID(), includePaymentLink: false },
      202,
    );
    assert.equal(msg.message.status, 'queued');
    const queue = await backend.mailer.processQueue();
    assert.equal(queue.sent, 1, JSON.stringify(queue));
    assert.equal(emails.length, 1);
    assert.ok(emails[0].body.attachments?.[0].content);
    const pdf = Buffer.from(emails[0].body.attachments[0].content, 'base64');
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.equal(
      (await call('/documents/' + inv.id + '/messages')).find((m) => m.id === msg.message.id).status,
      'sent',
    );
    check('Mongo outbox sends frozen invoice PDF through mocked email provider');
    await call(
      '/documents/' + cfInv.id + '/email',
      'POST',
      { requestId: randomUUID(), includePaymentLink: false },
      202,
    );
    await backend.mailer.processQueue();
    assert.equal(emails[1].headers.Authorization, 'Bearer ' + env.SHRI_SARRAF_RESEND_API_KEY);
    assert.ok(emails[1].body.from.startsWith('Shri Sarraf'));
    assert.ok(!emails[1].body.html.includes('Venturecore Solutions Private Limited'));
    check('Independent business keeps own email sender and legal identity');
    // Invoice emails reply to the business's finance email; its own sending address wins over EMAIL_FROM.
    assert.equal(emails[0].body.reply_to, 'finance@pirento.com');
    assert.equal(emails[1].body.reply_to, 'support@shrisarraf.com');
    const legalSaved = await backend.db.models.organizations.findById(legal.id);
    await backend.db.models.organizations.save({
      ...legalSaved,
      financeEmail: 'accounts@pirento.com',
      emailFrom: 'billing@pirento.com',
    });
    await call(
      '/documents/' + inv.id + '/email',
      'POST',
      { requestId: randomUUID(), includePaymentLink: false },
      202,
    );
    await backend.mailer.processQueue();
    assert.equal(
      emails.at(-1).body.from,
      `"${legalSaved.tradeName || legalSaved.name}" <billing@pirento.com>`,
    );
    assert.equal(emails.at(-1).body.reply_to, 'finance@pirento.com', 'the saved invoice keeps its reply-to');
    await backend.db.models.organizations.save(legalSaved);
    check('Business sending address and finance reply-to');
    const send = await call(
      '/documents/' + inv.id + '/email',
      'POST',
      { requestId: randomUUID(), includePaymentLink: false },
      202,
    );
    emailFail = true;
    await backend.mailer.processQueue();
    let failed = await backend.db.models.email.findById(send.message.id);
    assert.equal(failed.status, 'queued');
    assert.equal(failed.attempts, 1);
    const payload = failed.payload;
    emailFail = false;
    await backend.db
      .collection('email_outbox')
      .updateOne({ id: send.message.id }, { $set: { next_attempt_at: new Date(0).toISOString() } });
    await backend.mailer.processQueue();
    failed = await backend.db.models.email.findById(send.message.id);
    assert.equal(failed.status, 'sent');
    assert.deepEqual(failed.payload, { organizationId: payload.organizationId });
    const lastTwo = emails.slice(-2);
    assert.equal(lastTwo[0].headers['Idempotency-Key'], lastTwo[1].headers['Idempotency-Key']);
    assert.deepEqual(lastTwo[0].body, lastTwo[1].body);
    check('Email retry preserves exact PDF/body and provider idempotency key');

    // Two independent backend instances share MongoDB, while their in-memory locks do not.
    // Pause verification until both have read the same uncredited provider receipt.
    const sibling = await fixture.startInstance();
    const concurrentInvoice = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    const concurrentLinks = await call('/documents/' + concurrentInvoice.id + '/payment-link', 'POST', {});
    const concurrentLink = razorLinks.get(concurrentLinks.links[0].providerId);
    const concurrentPayment = {
      id: 'pay_CONCURRENT1',
      amount: 10000,
      currency: 'INR',
      status: 'captured',
      captured: true,
      created_at: Math.floor(Date.now() / 1000),
    };
    razorPayments.set(concurrentPayment.id, concurrentPayment);
    concurrentLink.amount_paid = 10000;
    concurrentLink.status = 'paid';
    concurrentLink.payments.push({ payment_id: concurrentPayment.id, amount: 10000, status: 'captured' });
    const concurrentEvent = {
      event: 'payment.captured',
      payload: {
        payment_link: { entity: { id: concurrentLink.id, reference_id: concurrentLink.reference_id } },
        payment: { entity: { id: concurrentPayment.id } },
      },
    };
    let arrivals = 0,
      release;
    const bothVerifying = new Promise((resolve) => {
      release = resolve;
    });
    paymentRendezvous = async () => {
      if (++arrivals === 2) release();
      await bothVerifying;
    };
    const concurrentResults = await Promise.all([
      webhook('razorpay', legal.id, concurrentEvent, 'concurrent-event', false, base),
      webhook('razorpay', legal.id, concurrentEvent, 'concurrent-event', false, sibling.base),
    ]);
    paymentRendezvous = undefined;
    assert.deepEqual(
      concurrentResults.map((result) => result.status),
      [200, 200],
      JSON.stringify(concurrentResults),
    );
    const concurrentReceipts = await call('/documents/' + concurrentInvoice.id + '/payments');
    assert.equal(concurrentReceipts.payments.length, 1);
    assert.equal(concurrentReceipts.document.amountPaid, 100);
    assert.equal(
      (await call('/documents/' + concurrentInvoice.id + '/online-payments')).links[0].state,
      'paid',
    );
    assert.equal(
      await backend.db
        .collection('online_verified_payments')
        .countDocuments({ provider_payment_id: concurrentPayment.id }),
      1,
    );
    check('Separate server instances atomically credit concurrent duplicate webhooks once');
    const reserveInvoice = await call('/documents', 'POST', input(legal.id, lc.id), 201);
    const beforeReservation = razorLinks.size;
    const reservations = await Promise.all(
      [base, sibling.base].map(async (host) => {
        const result = await fetch(host + '/api/documents/' + reserveInvoice.id + '/payment-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        return { status: result.status, data: await result.json() };
      }),
    );
    assert.ok(
      reservations.every((result) => [200, 409].includes(result.status)),
      JSON.stringify(reservations),
    );
    assert.equal(razorLinks.size, beforeReservation + 1);
    assert.equal(
      await backend.db.collection('online_payment_links').countDocuments({ document_id: reserveInvoice.id }),
      1,
    );
    check('Concurrent link reservation sends only one provider create request');
    assert.equal(passed, 13);
  },
);
