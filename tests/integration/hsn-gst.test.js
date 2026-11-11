/** Integration tests: the GST rate the invoice editor suggests for an HSN/SAC code. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test(
  'GST for an HSN comes from saved items, then earlier invoices, then the AI assistant',
  options,
  async (t) => {
    let aiAnswer = { known: true, rate: 18, covers: 'Professional services' };
    let aiCalls = 0;
    const { base, backend } = await createFixture(t, {
      auth: false,
      aiFetch: async () => {
        aiCalls += 1;
        return new Response(
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(aiAnswer) }] }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const call = async (path, method = 'GET', body, status = 200) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    };
    const organizationId = 'at-elevators';
    const lookup = (hsn, description = '') =>
      call(
        `/hsn-gst?organizationId=${organizationId}&hsn=${hsn}&description=${encodeURIComponent(description)}`,
      );
    const business = await backend.db.models.organizations.findById(organizationId);
    await backend.db.models.organizations.save({ ...business, gstin: '09AAJCV6240P1ZL', stateCode: '09' });

    await call(
      '/catalog',
      'POST',
      {
        organizationId,
        type: 'product',
        name: 'Passenger lift',
        description: '',
        sku: '',
        hsn: '8428',
        unit: 'Nos',
        rate: 900000,
        gstRate: 18,
        active: true,
      },
      201,
    );
    assert.deepEqual(await lookup('8428'), {
      rate: 18,
      source: 'catalog',
      note: 'from your saved item “Passenger lift”',
    });

    const buyer = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Buyer',
        email: '',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    const invoice = await call(
      '/documents',
      'POST',
      {
        organizationId,
        customerId: buyer.id,
        kind: 'invoice',
        status: 'sent',
        issueDate: '2026-10-15',
        dueDate: '2026-10-15',
        title: 'AMC',
        items: [
          {
            description: 'Annual maintenance',
            hsn: '998719',
            quantity: 1,
            unit: 'Year',
            rate: 30000,
            gstRate: 5,
          },
        ],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
      },
      201,
    );
    assert.deepEqual(await lookup('998719'), {
      rate: 5,
      source: 'history',
      note: `as on your invoice ${invoice.number}`,
    });

    assert.deepEqual(await lookup('9983'), { rate: null }, 'no AI key, nothing known');
    await call('/ai-settings', 'PUT', { apiKey: 'sk-test-key', model: 'gpt-4o-mini' });
    assert.deepEqual(await lookup('9983', 'Consulting'), {
      rate: 18,
      source: 'ai',
      note: 'AI suggestion for 9983 (Professional services); please check before issuing',
    });
    await lookup('9983', 'Consulting');
    assert.equal(aiCalls, 1, 'the same code is answered from the cache');
    aiAnswer = { known: false, rate: 18, covers: '' };
    assert.deepEqual(await lookup('9999'), { rate: null }, 'an unsure answer is not suggested');
    await call(`/hsn-gst?organizationId=${organizationId}&hsn=12345`, 'GET', undefined, 400);
  },
);
