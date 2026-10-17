/** Integration tests: recurring schedules, draft generation, concurrency, failures and catch-up. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';
import { createRecurringInvoices } from '../../src/services/recurring/recurring-invoices.js';
import { createWorkspaceService } from '../../src/services/workspace-service.js';
import { attachPageRoutes } from '../../src/routes/pages.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const organizationId = 'pipeline2-legal';
const clock = () => new Date('2026-10-10T12:00:00.000Z');

async function recurringFixture(t, options = {}) {
  const fixture = await createFixture(t, { now: clock, auth: false, ...options });
  async function api(path, method = 'GET', input, expected = 200, base = fixture.base, cookie = '') {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const data = await response.json();
    assert.ok(
      [].concat(expected).includes(response.status),
      `${method} ${path}: ${response.status} ${JSON.stringify(data)}`,
    );
    return data;
  }
  const customer = await api(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Recurring buyer',
      email: 'recurring-buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
      roles: ['customer'],
      active: true,
    },
    201,
  );
  async function invoice(extra = {}) {
    return api(
      '/documents',
      'POST',
      {
        organizationId,
        customerId: customer.id,
        kind: 'invoice',
        status: 'draft',
        issueDate: '2026-10-01',
        dueDate: '2026-10-31',
        title: 'Frozen recurring service',
        items: [{ description: 'Saved service', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: 'Saved recurring notes',
        terms: 'Saved recurring terms',
        ...extra,
      },
      201,
    );
  }
  async function create(source, extra = {}) {
    return (
      await api(
        '/recurring-invoices',
        'POST',
        {
          organizationId,
          sourceDocumentId: source.id,
          sourceVersion: source.version,
          requestId: randomUUID(),
          name: 'Monthly service',
          frequency: 'monthly',
          startDate: '2026-10-01',
          dueDays: 30,
          endDate: '',
          maxOccurrences: null,
          active: false,
          ...extra,
        },
        201,
      )
    ).schedule;
  }
  const detail = (id) => api(`/recurring-invoices/${id}?organizationId=${organizationId}`);
  const generate = (schedule, expected = 201, base) =>
    api(
      `/recurring-invoices/${schedule.id}/generate`,
      'POST',
      {
        organizationId,
        version: schedule.version,
        occurrenceDate: schedule.nextDate,
      },
      expected,
      base,
    );
  return { ...fixture, api, customer, invoice, create, detail, generate };
}

test(
  'Recurring schedules start explicitly, freeze commercial terms, refresh identities and number scheduled financial years',
  settings,
  async (t) => {
    const f = await recurringFixture(t, { now: () => new Date('2026-04-30T12:00:00Z') });
    assert.equal(await f.backend.db.collection('recurring_invoice_schedules').countDocuments(), 0);
    assert.deepEqual(await f.backend.recurringInvoices.processDue(), { processed: 0, created: 0, failed: 0 });
    const source = await f.invoice({ issueDate: '2026-01-01', dueDate: '2026-01-31' });
    let schedule = await f.create(source, { startDate: '2026-01-31', maxOccurrences: 4 });
    assert.equal(schedule.status, 'paused');
    assert.equal((await f.backend.recurringInvoices.processDue()).created, 0);
    assert.equal(await f.backend.db.collection('documents').countDocuments(), 1);
    const updatedSource = await f.api(`/documents/${source.id}`, 'PUT', {
      ...source,
      title: 'Later changed source',
      items: [{ ...source.items[0], rate: 200 }],
    });
    await f.api(`/customers/${f.customer.id}`, 'PUT', { ...f.customer, name: 'Current buyer identity' });
    const formats = await f.api('/formats?organizationId=' + organizationId);
    const currentFormat = formats.find((format) => format.id === source.formatId);
    await f.api('/formats/' + currentFormat.id, 'PUT', { ...currentFormat, name: 'Current format identity' });
    schedule = await f.api(`/recurring-invoices/${schedule.id}/status`, 'POST', {
      organizationId,
      version: schedule.version,
      action: 'resume',
    });
    const documents = [];
    for (const expectedDate of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']) {
      assert.equal(schedule.nextDate, expectedDate);
      const outcome = await f.generate(schedule);
      const document = await f.backend.db.models.documents.findById(outcome.document.id);
      documents.push(document);
      assert.equal(document.status, 'draft');
      assert.equal(document.title, 'Frozen recurring service');
      assert.equal(document.items[0].rate, 100);
      assert.equal(document.totals.total, 100);
      assert.equal(document.customerSnapshot.name, 'Current buyer identity');
      assert.equal(document.formatSnapshot.name, 'Current format identity');
      assert.equal(document.issueDate, expectedDate);
      assert.equal(document.recurringScheduleId, schedule.id);
      assert.equal(document.recurringScheduledDate, expectedDate);
      schedule = outcome.schedule;
    }
    assert.equal(new Set(documents.map((document) => document.id)).size, 4);
    assert.equal(new Set(documents.map((document) => document.number)).size, 4);
    assert.ok(documents.slice(0, 3).every((document) => document.number.includes('/2526/')));
    assert.match(documents[3].number, /\/2627\//);
    assert.equal(documents[0].dueDate, '2026-03-02');
    assert.equal(schedule.status, 'completed');
    assert.equal(schedule.nextDate, '');
    assert.equal(schedule.generatedCount, 4);
    assert.deepEqual(await f.backend.db.models.documents.findById(source.id), updatedSource);
    assert.equal(await f.backend.db.collection('email_outbox').countDocuments(), 0);
    assert.equal(await f.backend.db.collection('online_payment_links').countDocuments(), 0);
    const detail = await f.detail(schedule.id);
    assert.equal(detail.history.length, 4);
    assert.equal(detail.schedule.sourceSnapshot.customer.name, 'Recurring buyer');
    assert.equal(detail.schedule.template.items[0].rate, 100);
  },
);

test(
  'A paid linked source produces a clean draft without receipts, installments, delivery state or source mutation',
  settings,
  async (t) => {
    const f = await recurringFixture(t);
    let source = await f.invoice({
      status: 'sent',
      installmentPlan: {
        name: 'One payment',
        installments: [{ id: 'full', label: 'Full amount', amount: 100, dueDate: '2026-10-31' }],
      },
    });
    const delivery = await f.api(`/documents/${source.id}/delivery-note`, 'POST', {}, 201);
    await f.api(
      `/documents/${source.id}/payments`,
      'POST',
      {
        requestId: randomUUID(),
        amount: 100,
        paidOn: '2026-10-10',
        method: 'bank_transfer',
        reference: 'SOURCE ONLY',
        notes: '',
        finalizeWhenPaid: true,
      },
      201,
    );
    source = await f.backend.db.models.documents.findById(source.id);
    assert.equal(source.status, 'paid');
    assert.ok(source.finalizedAt);
    assert.equal(source.deliveryNoteId, delivery.id);
    const baselineEmails = await f.backend.db.collection('email_outbox').countDocuments();
    const schedule = await f.create(source, { active: true, maxOccurrences: 1 });
    const outcome = await f.generate(schedule);
    const generated = await f.backend.db.models.documents.findById(outcome.document.id);
    assert.equal(generated.status, 'draft');
    assert.equal(generated.amountPaid, 0);
    assert.equal(generated.balanceDue, 100);
    for (const field of [
      'sourceQuotationId',
      'sourceDocumentId',
      'convertedInvoiceId',
      'deliveryNoteId',
      'finalizedAt',
      'installmentPlan',
    ])
      assert.equal(generated[field], null, field);
    assert.equal(generated.shipping, undefined);
    assert.equal((await f.backend.db.models.payments.list(generated.id)).length, 0);
    assert.equal(await f.backend.db.collection('email_outbox').countDocuments(), baselineEmails);
    assert.deepEqual(await f.backend.db.models.documents.findById(source.id), source);
  },
);

test(
  'Concurrent instances and repeated create/generate requests keep one occurrence even after draft deletion',
  settings,
  async (t) => {
    const f = await recurringFixture(t);
    const other = await f.startInstance();
    const source = await f.invoice();
    const input = {
      organizationId,
      sourceDocumentId: source.id,
      sourceVersion: source.version,
      requestId: randomUUID(),
      name: 'Retry schedule',
      frequency: 'monthly',
      startDate: '2026-10-01',
      dueDays: 0,
      endDate: '',
      maxOccurrences: 2,
      active: true,
    };
    const created = await Promise.all(
      [f.base, other.base, f.base, other.base].map((base) =>
        f.api('/recurring-invoices', 'POST', input, [200, 201], base),
      ),
    );
    assert.equal(new Set(created.map((result) => result.schedule.id)).size, 1);
    assert.equal(created.filter((result) => result.created).length, 1);
    const schedule = created[0].schedule;
    const conflict = await f.api(
      '/recurring-invoices',
      'POST',
      { ...input, name: 'Different request body' },
      409,
    );
    assert.equal(conflict.code, 'RECURRING_REQUEST_CONFLICT');
    const results = await Promise.all(
      [f.base, other.base, f.base, other.base].map((base) => f.generate(schedule, [200, 201], base)),
    );
    assert.equal(new Set(results.map((result) => result.document.id)).size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(
      await f.backend.db
        .collection('recurring_invoice_occurrences')
        .countDocuments({ scheduleId: schedule.id }),
      1,
    );
    const documentId = results[0].document.id;
    await f.api(`/documents/${documentId}`, 'DELETE');
    const replay = await f.generate(schedule, 200, other.base);
    assert.equal(replay.document, null);
    assert.equal(replay.occurrence.documentAvailable, false);
    assert.equal(replay.created, false);
    assert.equal(
      await f.backend.db.collection('documents').countDocuments({ recurringScheduleId: schedule.id }),
      0,
    );
    const detail = await f.detail(schedule.id);
    assert.equal(detail.history[0].status, 'generated');
    assert.equal(detail.history[0].documentAvailable, false);
    assert.equal(detail.schedule.generatedCount, 1);
  },
);

test(
  'Generation failure pauses the same occurrence; active references must be repaired before an explicit resume',
  settings,
  async (t) => {
    const f = await recurringFixture(t);
    const catalog = await f.api(
      '/catalog',
      'POST',
      {
        organizationId,
        name: 'Retained service',
        sku: 'RECURRING-1',
        description: 'Recurring service',
        type: 'service',
        unit: 'Month',
        hsn: '',
        rate: 100,
        gstRate: 0,
        active: true,
      },
      201,
    );
    const source = await f.invoice({
      items: [
        {
          description: 'Frozen service',
          catalogItemId: catalog.id,
          quantity: 1,
          rate: 100,
          gstRate: 0,
          hsn: '',
        },
      ],
    });
    let schedule = await f.create(source, { active: true });
    await f.api(`/catalog/${catalog.id}`, 'PUT', { ...catalog, active: false });
    const first = await f.generate(schedule, 422);
    assert.equal(first.code, 'RECURRING_GENERATION_FAILED');
    assert.equal(first.schedule.status, 'error');
    assert.equal(first.schedule.nextDate, '2026-10-01');
    assert.equal(first.schedule.nextIndex, 0);
    assert.equal(first.schedule.generatedCount, 0);
    assert.equal(first.occurrence.status, 'failed');
    assert.equal(first.occurrence.attempts, 1);
    assert.equal(
      await f.backend.db.collection('documents').countDocuments({ recurringScheduleId: schedule.id }),
      0,
    );
    assert.equal((await f.backend.recurringInvoices.processDue()).processed, 0);
    schedule = first.schedule;
    await f.api(
      `/recurring-invoices/${schedule.id}/status`,
      'POST',
      { organizationId, version: schedule.version, action: 'resume' },
      400,
    );
    await f.api(`/catalog/${catalog.id}`, 'PUT', { ...catalog, rate: 999, active: true });
    await f.api(`/customers/${f.customer.id}`, 'PUT', { ...f.customer, active: false });
    await f.api(
      `/recurring-invoices/${schedule.id}/status`,
      'POST',
      { organizationId, version: schedule.version, action: 'resume' },
      400,
    );
    await f.api(`/customers/${f.customer.id}`, 'PUT', { ...f.customer, active: true });
    schedule = await f.api(`/recurring-invoices/${schedule.id}/status`, 'POST', {
      organizationId,
      version: schedule.version,
      action: 'resume',
    });
    const recovered = await f.generate(schedule);
    assert.equal(recovered.occurrence.scheduledDate, '2026-10-01');
    assert.equal(recovered.occurrence.attempts, 2);
    assert.ok(recovered.occurrence.lastFailure);
    assert.equal((await f.backend.db.models.documents.findById(recovered.document.id)).items[0].rate, 100);
    const history = (await f.detail(schedule.id)).history;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'generated');
    assert.equal(history[0].attempts, 2);
    assert.equal(
      await f.backend.db
        .collection('recurring_invoice_events')
        .countDocuments({ scheduleId: schedule.id, type: 'generation_failed' }),
      1,
    );
  },
);

test(
  'A failed transaction rolls back its draft/number and an uncertain commit recovers its durable occurrence',
  settings,
  async (t) => {
    const f = await recurringFixture(t);
    const source = await f.invoice();
    let schedule = await f.create(source, { active: true });
    const workspace = createWorkspaceService({ db: f.backend.db, now: clock });
    let injectFailure = true;
    const broken = createRecurringInvoices({
      db: f.backend.db,
      now: clock,
      workspace: {
        ...workspace,
        async newDocument(...args) {
          const document = await workspace.newDocument(...args);
          if (injectFailure) {
            injectFailure = false;
            throw new Error('Simulated crash before occurrence commit');
          }
          return document;
        },
      },
    });
    const failed = await broken.generate(
      organizationId,
      schedule.id,
      { version: schedule.version, occurrenceDate: schedule.nextDate },
      'test-admin',
    );
    assert.equal(failed.failed, true);
    assert.equal(await f.backend.db.collection('documents').countDocuments(), 1);
    const sequence = await f.backend.db
      .collection('sequences')
      .findOne({ organizationId, kind: 'invoice', fiscalYear: '2627' });
    assert.equal(sequence.value, 1);
    schedule = await f.api(`/recurring-invoices/${schedule.id}/status`, 'POST', {
      organizationId,
      version: failed.schedule.version,
      action: 'resume',
    });
    let loseCommitResponse = true;
    const uncertainDb = {
      ...f.backend.db,
      async transaction(action, options) {
        const result = await f.backend.db.transaction(action, options);
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error('Simulated lost commit response');
        }
        return result;
      },
    };
    const uncertain = createRecurringInvoices({ db: uncertainDb, now: clock, workspace });
    const result = await uncertain.generate(
      organizationId,
      schedule.id,
      { version: schedule.version, occurrenceDate: schedule.nextDate },
      'test-admin',
    );
    assert.equal(result.failed, undefined);
    assert.equal(result.created, false);
    assert.match(result.document.number, /0002$/);
    assert.equal(
      await f.backend.db.collection('documents').countDocuments({ recurringScheduleId: schedule.id }),
      1,
    );
    assert.equal((await f.detail(schedule.id)).schedule.status, 'active');
  },
);

test(
  'Automatic backlog catch-up is bounded across instances, observes cooldown and drains one in-flight operation on stop',
  settings,
  async (t) => {
    let timestamp = '2026-10-10T12:00:00Z';
    const now = () => new Date(timestamp);
    const f = await recurringFixture(t, { now });
    const source = await f.invoice();
    const schedule = await f.create(source, { active: true, frequency: 'weekly', startDate: '2026-01-01' });
    const second = await f.startInstance();
    await Promise.all([
      f.backend.recurringInvoices.processDue(),
      second.backend.recurringInvoices.processDue(),
    ]);
    assert.equal((await f.detail(schedule.id)).schedule.generatedCount, 1);
    await f.backend.recurringInvoices.processDue();
    assert.equal((await f.detail(schedule.id)).schedule.generatedCount, 1);
    timestamp = '2026-10-10T12:01:01Z';
    await second.backend.recurringInvoices.processDue();
    assert.equal((await f.detail(schedule.id)).schedule.generatedCount, 2);
    for (let index = 0; index < 22; index++)
      await f.create(source, { active: true, name: `Bounded batch ${index}` });
    const batch = await f.backend.recurringInvoices.processDue();
    assert.equal(batch.created, 20);
    const workspace = createWorkspaceService({ db: f.backend.db, now });
    let release;
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const draining = createRecurringInvoices({
      db: f.backend.db,
      now,
      workspace: {
        ...workspace,
        async newDocument(...args) {
          started();
          await gate;
          return workspace.newDocument(...args);
        },
      },
    });
    const pending = draining.processDue();
    await entered;
    let stopped = false;
    const stop = draining.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    const drained = await pending;
    await stop;
    assert.equal(drained.created, 1);
    assert.equal(stopped, true);
    assert.equal((await draining.processDue()).stopped, true);
  },
);

test(
  'Schedule edits require the current revision, preserve pending dates, and enforce bounded input',
  settings,
  async (t) => {
    const f = await recurringFixture(t);
    const source = await f.invoice();
    let schedule = await f.create(source);
    const change = {
      organizationId,
      version: schedule.version,
      name: 'Reviewed schedule',
      dueDays: 15,
      endDate: '',
      maxOccurrences: null,
    };
    const updated = await f.api(`/recurring-invoices/${schedule.id}`, 'PUT', change);
    const stale = await f.api(`/recurring-invoices/${schedule.id}`, 'PUT', { ...change, dueDays: 99 }, 409);
    assert.equal(stale.code, 'RECURRING_VERSION_CONFLICT');
    await f.api(
      `/recurring-invoices/${schedule.id}/status`,
      'POST',
      { organizationId, version: schedule.version, action: 'resume' },
      409,
    );
    assert.equal(updated.nextDate, schedule.nextDate);
    assert.equal(updated.dueDays, 15);
    await f.api(
      `/recurring-invoices/${schedule.id}`,
      'PUT',
      { ...change, version: updated.version, dueDays: 366 },
      400,
    );
    await f.api(
      `/recurring-invoices/${schedule.id}`,
      'PUT',
      { ...change, version: updated.version, endDate: '2026-09-30' },
      400,
    );
    await f.api(
      `/recurring-invoices/${schedule.id}`,
      'PUT',
      { ...change, version: updated.version, frequency: 'weekly' },
      400,
    );
    schedule = await f.api(`/recurring-invoices/${schedule.id}/status`, 'POST', {
      organizationId,
      version: updated.version,
      action: 'resume',
    });
    await f.api(`/recurring-invoices/${schedule.id}`, 'PUT', { ...change, version: schedule.version }, 409);
    const wrongOrganization = 'at-facilities';
    await f.api(
      `/recurring-invoices/${schedule.id}?organizationId=${wrongOrganization}`,
      'GET',
      undefined,
      404,
    );
    await f.api(
      '/recurring-invoices',
      'POST',
      {
        organizationId: wrongOrganization,
        sourceDocumentId: source.id,
        sourceVersion: source.version,
        requestId: randomUUID(),
        name: 'Foreign source',
        frequency: 'monthly',
        startDate: '2026-10-01',
        dueDays: 0,
        endDate: '',
        maxOccurrences: null,
        active: false,
      },
      404,
    );
  },
);

test(
  'Authorized staff can view recurring history, while management and unassigned business access remain admin scoped',
  settings,
  async (t) => {
    const f = await createFixture(t, {
      now: clock,
      environment: {
        INITIAL_ADMIN_EMAIL: 'recurring-admin@example.test',
        INITIAL_ADMIN_PASSWORD: 'RecurringAdminChecks123!',
        INITIAL_ADMIN_NAME: 'Recurring admin',
      },
    });
    attachPageRoutes(f.backend);
    async function call(path, method = 'GET', body, expected = 200, cookie = '') {
      const response = await fetch(f.base + path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      assert.equal(response.status, expected, `${path}: ${text.slice(0, 400)}`);
      return {
        response,
        text,
        data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null,
      };
    }
    const login = await call('/api/auth/login', 'POST', {
      email: f.environment.INITIAL_ADMIN_EMAIL,
      password: f.environment.INITIAL_ADMIN_PASSWORD,
    });
    const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
    const customer = (
      await call(
        '/api/customers',
        'POST',
        {
          organizationId,
          name: 'Staff history buyer',
          email: 'staff-history@example.test',
          phone: '',
          gstin: '',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: '',
        },
        201,
        adminCookie,
      )
    ).data;
    const source = (
      await call(
        '/api/documents',
        'POST',
        {
          organizationId,
          customerId: customer.id,
          kind: 'invoice',
          status: 'draft',
          issueDate: '2026-10-10',
          dueDate: '',
          title: 'Authorized source',
          items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
        201,
        adminCookie,
      )
    ).data;
    const input = {
      organizationId,
      sourceDocumentId: source.id,
      sourceVersion: source.version,
      requestId: randomUUID(),
      name: 'Authorized schedule',
      frequency: 'monthly',
      startDate: '2026-10-10',
      dueDays: 10,
      endDate: '',
      maxOccurrences: 2,
      active: false,
    };
    const schedule = (await call('/api/recurring-invoices', 'POST', input, 201, adminCookie)).data.schedule;
    await call(
      '/api/auth/signup',
      'POST',
      {
        name: 'Recurring staff',
        email: 'recurring-staff@example.test',
        password: 'RecurringStaffChecks123!',
        company: 'Test',
      },
      202,
    );
    const user = (await call('/api/auth/users', 'GET', undefined, 200, adminCookie)).data.find(
      (user) => user.email === 'recurring-staff@example.test',
    );
    await call(
      '/api/auth/users/' + user.id,
      'PATCH',
      { role: 'staff', status: 'active', organizationIds: [organizationId] },
      200,
      adminCookie,
    );
    const staffLogin = await call('/api/auth/login', 'POST', {
      email: user.email,
      password: 'RecurringStaffChecks123!',
    });
    const staffCookie = staffLogin.response.headers.get('set-cookie').split(';')[0];
    await call(
      `/api/recurring-invoices?organizationId=${organizationId}`,
      'GET',
      undefined,
      200,
      staffCookie,
    );
    await call(
      `/api/recurring-invoices/${schedule.id}?organizationId=${organizationId}`,
      'GET',
      undefined,
      200,
      staffCookie,
    );
    await call(
      `/api/recurring-invoices/${schedule.id}?organizationId=at-facilities`,
      'GET',
      undefined,
      403,
      staffCookie,
    );
    await call('/api/recurring-invoices', 'POST', { ...input, requestId: randomUUID() }, 403, staffCookie);
    await call(
      `/api/recurring-invoices/${schedule.id}`,
      'PUT',
      {
        organizationId,
        version: schedule.version,
        name: 'Forbidden edit',
        dueDays: 1,
        endDate: '',
        maxOccurrences: null,
      },
      403,
      staffCookie,
    );
    await call(
      `/api/recurring-invoices/${schedule.id}/status`,
      'POST',
      { organizationId, version: schedule.version, action: 'resume' },
      403,
      staffCookie,
    );
    await call(
      `/api/recurring-invoices/${schedule.id}/generate`,
      'POST',
      { organizationId, version: schedule.version, occurrenceDate: schedule.nextDate },
      403,
      staffCookie,
    );
    const staffPage = await call(
      `/workspace/${organizationId}/recurring/edit/${schedule.id}`,
      'GET',
      undefined,
      200,
      staffCookie,
    );
    assert.match(staffPage.text, /Occurrence history/);
    assert.doesNotMatch(staffPage.text, /data-recurring-save|data-recurring-state=/);
    await call(`/workspace/${organizationId}/recurring/new`, 'GET', undefined, 403, staffCookie);
    await call('/workspace/at-facilities/recurring', 'GET', undefined, 403, staffCookie);
    const newPage = await call(
      `/workspace/${organizationId}/recurring/new?documentId=${source.id}`,
      'GET',
      undefined,
      200,
      adminCookie,
    );
    assert.match(newPage.text, /Frozen|FROZEN SOURCE TEMPLATE/);
  },
);
