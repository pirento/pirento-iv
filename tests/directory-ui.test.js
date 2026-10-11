import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberNotice, clearWorkspaceStorage } from '../public/js/core/optional-storage.js';
import { afterSave } from '../public/js/management/common.js';
import { readDirectoryFilters, directoryCsv } from '../src/services/pages/directory-list.js';
import { directoryFilter } from '../src/models/directory-queries.js';
import { replaceDirectoryRows } from '../public/js/documents/directory-picker.js';
import {
  beginContactHandoff,
  completeContactHandoff,
  peekContactHandoff,
  consumeContactHandoff,
} from '../public/js/documents/editor-state.js';

test('optional blocked or full storage never prevents successful-save navigation', (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    for (const [key, descriptor] of [
      ['sessionStorage', originalStorage],
      ['location', originalLocation],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let destination;
  globalThis.location = {
    origin: 'https://example.invalid',
    search: '',
    assign(value) {
      destination = value;
    },
  };
  const cases = [
    {
      configurable: true,
      get() {
        throw new Error('Storage disabled');
      },
    },
    {
      configurable: true,
      value: {
        setItem() {
          throw new Error('Storage full');
        },
        removeItem() {
          throw new Error('Denied');
        },
        'vc:draft': 'value',
      },
    },
  ];
  for (const descriptor of cases) {
    Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    assert.doesNotThrow(() => rememberNotice('Saved'));
    assert.doesNotThrow(() => clearWorkspaceStorage());
    afterSave('/workspace/business/catalog', 'catalogId', { id: 'saved', type: 'product' });
    assert.equal(destination, '/workspace/business/catalog');
  }
});

test('directory request shapes stay bounded and literal and exact reads keep organization scope', () => {
  assert.equal(readDirectoryFilters('customers').pageSize, 50);
  assert.equal(readDirectoryFilters('catalog', {}, { lookup: true }).pageSize, 20);
  for (const query of [
    { page: '0' },
    { page: '-1' },
    { q: { $ne: '' } },
    { role: '$where' },
    { product: 'bad/id' },
    {
      ids: Array(51)
        .fill(0)
        .map((_, i) => 'id-' + i)
        .join(','),
    },
  ])
    assert.throws(() => readDirectoryFilters('customers', query), { status: 400 });
  const filter = directoryFilter('mine', 'customers', readDirectoryFilters('customers', { q: '[x]*' }));
  assert.deepEqual(filter.$and[0], { organizationId: 'mine' });
  assert.equal(filter.$and.at(-1).$or[0].name.$regex, '\\[x\\]\\*');
  const exact = directoryFilter(
    'mine',
    'catalog',
    readDirectoryFilters('catalog', { ids: 'one,two' }, { lookup: true }),
  );
  assert.deepEqual(exact, { $and: [{ organizationId: 'mine' }, { id: { $in: ['one', 'two'] } }] });
});

test('many editor searches keep only one result page plus referenced records', () => {
  const rows = [{ id: 'selected' }];
  for (let page = 0; page < 100; page++) {
    replaceDirectoryRows(
      rows,
      Array.from({ length: 20 }, (_, i) => ({ id: `page-${page}-${i}` })),
      ['selected'],
    );
    assert.equal(rows.length, 21);
    assert.ok(rows.some((item) => item.id === 'selected'));
  }
});

test('contact handoff can be inspected while fetching, without losing its single-use and scope checks', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const token = 'handoff-test-12345678';
  const scope = { organizationId: 'mine', draftId: 'draft', returnTo: '/workspace/mine/invoices/new' };
  assert.equal(beginContactHandoff(storage, token, scope), true);
  assert.equal(completeContactHandoff(storage, token, { ...scope, contactId: 'contact' }), true);
  assert.equal(peekContactHandoff(storage, token, { ...scope, draftId: 'other' }), '');
  assert.equal(peekContactHandoff(storage, token, scope), 'contact');
  assert.equal(peekContactHandoff(storage, token, scope), 'contact');
  assert.equal(consumeContactHandoff(storage, token, scope), 'contact');
  assert.equal(consumeContactHandoff(storage, token, scope), '');
});

test('directory CSV streams complete rows and neutralizes spreadsheet formulas', async () => {
  let closed = false;
  const cursor = {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 75; index++)
        yield {
          id: String(index),
          name: index ? 'Contact ' + index : '  =HYPERLINK("x")',
          roles: ['customer'],
          active: true,
        };
    },
    async close() {
      closed = true;
    },
  };
  let csv = '';
  for await (const chunk of directoryCsv('customers', cursor)) csv += chunk;
  assert.equal(csv.trim().split('\r\n').length, 76);
  assert.ok(csv.includes('"\'  =HYPERLINK(""x"")"'));
  assert.equal(closed, true);
});
