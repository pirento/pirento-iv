import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readWorkspaceRoute,
  safeWorkspaceReturn,
  workspaceUrl,
  WORKSPACE_VIEWS,
  type WorkspaceRoute,
  type WorkspaceView,
} from '../../src/app/workspace-route';

const organizationId = 'pipeline2-ecosystem';
function parsedUrl(url: string) {
  const parsed = new URL(url, 'https://workspace.example');
  return readWorkspaceRoute(parsed.pathname, parsed.search);
}

test('public authentication pages are separate from every organization workspace view', () => {
  for (const pathname of ['/', '/login', '/signup', '/forgot-password', '/reset-password'])
    assert.equal(readWorkspaceRoute(pathname), null);
  for (const view of WORKSPACE_VIEWS) {
    const route = { organizationId, view };
    assert.deepEqual(readWorkspaceRoute(`/workspace/${organizationId}/${view}`), route);
    assert.deepEqual(parsedUrl(workspaceUrl(route)), route);
  }
  assert.equal(readWorkspaceRoute('/login/extra')?.view, 'not_found');
  assert.equal(readWorkspaceRoute('/workspace')?.view, 'not_found');
});

test('document deep links reconstruct their action and organization on a fresh URL parse', () => {
  for (const view of ['invoices', 'quotations', 'proformas', 'shipping'] as const) {
    const newRoute = { organizationId, view, action: 'new' as const };
    assert.deepEqual(parsedUrl(workspaceUrl(newRoute)), newRoute);
    for (const action of ['edit', 'preview', 'delete'] as const) {
      const route = { organizationId, view, action, id: 'document_123-abc' };
      assert.deepEqual(parsedUrl(workspaceUrl(route)), route);
    }
  }
  for (const action of ['payments', 'email'] as const) {
    const route = { organizationId: 'shri-sarraf', view: 'invoices' as const, action, id: 'invoice-1' };
    assert.deepEqual(parsedUrl(workspaceUrl(route)), route);
    assert.equal(parsedUrl(workspaceUrl(route))?.organizationId, 'shri-sarraf');
  }
});

test('manager pages preserve creation, editing, confirmation and supported copy-source links', () => {
  for (const view of ['customers', 'catalog', 'formats', 'business_products'] as const) {
    assert.deepEqual(parsedUrl(workspaceUrl({ organizationId, view, action: 'new' })), {
      organizationId,
      view,
      action: 'new',
    });
    for (const action of ['edit', 'delete'] as const) {
      const route = { organizationId, view, action, id: 'record-123' };
      assert.deepEqual(parsedUrl(workspaceUrl(route)), route);
    }
  }
  for (const view of ['catalog', 'formats', 'business_products'] as const) {
    const copy = { organizationId, view, action: 'new' as const, id: 'copy-source-123' };
    assert.deepEqual(parsedUrl(workspaceUrl(copy)), copy);
  }
  for (const route of [
    { organizationId, view: 'organizations' as const, action: 'new' as const },
    { organizationId, view: 'organizations' as const, action: 'edit' as const, id: 'other-organization' },
  ])
    assert.deepEqual(parsedUrl(workspaceUrl(route)), route);
});

test('unavailable route shapes produce not-found without losing the valid organization scope', () => {
  const invalidSuffixes = [
    'unknown',
    'invoices/unknown/item',
    'invoices/edit',
    'invoices/new/unexpected-id',
    'invoices/edit/id/extra',
    'customers/edit',
    'customers/preview/id',
    'formats/payments/id',
    'organizations/delete/id',
    'organizations/new/id',
    'organizations/edit',
    'team/new',
    'help/edit/id',
    'dashboard_branding/new',
    'business_settings/edit/id',
    'quotations/payments/id',
    'proformas/payments/id',
    'shipping/payments/id',
  ];
  for (const suffix of invalidSuffixes)
    assert.deepEqual(
      readWorkspaceRoute(`/workspace/${organizationId}/${suffix}`),
      { organizationId, view: 'not_found' },
      suffix,
    );
});

test('encoded identifiers round-trip once while malformed encodings and traversal are rejected', () => {
  assert.deepEqual(readWorkspaceRoute('/workspace/%73hri-sarraf/invoices/edit/invoice%2D1'), {
    organizationId: 'shri-sarraf',
    view: 'invoices',
    action: 'edit',
    id: 'invoice-1',
  });
  const invalid = [
    '/workspace/%/invoices',
    '/workspace/%E0%A4%A/invoices',
    '/workspace/%ZZ/invoices',
    '/workspace/../invoices',
    '/workspace/%2e%2e/invoices',
    '/workspace/%252e%252e/invoices',
    '/workspace/org%2Fother/invoices',
    '/workspace/org%5Cother/invoices',
    '/workspace/org%00/invoices',
    '/workspace/org%0A/invoices',
    '/workspace/<script>/invoices',
    '/workspace/user@host/invoices',
    '/workspace/org/invoices/edit/..',
    '/workspace/org/invoices/edit/%2fsecret',
    '/workspace/org/invoices/edit/%5csecret',
    '/workspace/org/invoices/edit/%00',
    `/workspace/${'a'.repeat(201)}/invoices`,
    `/workspace/org/invoices/edit/${'a'.repeat(201)}`,
  ];
  for (const pathname of invalid) assert.equal(readWorkspaceRoute(pathname)?.view, 'not_found', pathname);
  assert.equal(readWorkspaceRoute(`/workspace/${'a'.repeat(200)}/invoices`)?.organizationId.length, 200);
});

test('manager query parameters are allowlisted and invalid role, type and product identifiers are ignored', () => {
  const path = `/workspace/${organizationId}/catalog/new`;
  assert.deepEqual(
    readWorkspaceRoute(
      path,
      '?role=vendor&itemType=product&suggestion=Gold+chain&businessProductId=ecosystem-product-2&admin=true&redirect=https://evil.example&apiKey=secret',
    ),
    {
      organizationId,
      view: 'catalog',
      action: 'new',
      role: 'vendor',
      itemType: 'product',
      suggestion: 'Gold chain',
      businessProductId: 'ecosystem-product-2',
    },
  );
  for (const role of ['customer', 'vendor', 'b2b_buyer'] as const)
    assert.equal(readWorkspaceRoute(path, `?role=${role}`)?.role, role);
  assert.deepEqual(
    readWorkspaceRoute(
      path,
      '?role=admin&itemType=script&businessProductId=../other&suggestion=' + 'x'.repeat(201),
    ),
    { organizationId, view: 'catalog', action: 'new' },
  );
  assert.equal(readWorkspaceRoute(path, '?role=vendor&role=admin')?.role, 'vendor');
  assert.equal(readWorkspaceRoute(path, '?businessProductId=first%2Fsecond')?.businessProductId, undefined);
});

test('URL builder escapes suggestion text and path identifiers without introducing extra query fields or executable markup', () => {
  const suggestion = 'Service & support / एक "quote" <script>alert(1)</script>?role=admin#fragment';
  const route: WorkspaceRoute = {
    organizationId,
    view: 'catalog',
    action: 'new',
    suggestion,
    itemType: 'service',
    businessProductId: 'product-1',
  };
  const url = workspaceUrl(route);
  assert.equal(url.includes('<script>'), false);
  assert.equal(new URL(url, 'https://workspace.example').hash, '');
  assert.equal(new URL(url, 'https://workspace.example').searchParams.has('role'), false);
  assert.deepEqual(parsedUrl(url), route);
  const encoded = workspaceUrl({
    organizationId: 'org/segment',
    view: 'invoices',
    action: 'preview',
    id: 'id?query&value',
  });
  assert.match(encoded, /org%2Fsegment\/invoices\/preview\/id%3Fquery%26value$/);
  assert.equal(parsedUrl(encoded)?.view, 'not_found');
});

test('authentication return paths reject external schemes, userinfo, lookalike prefixes and traversal', () => {
  const unsafe = [
    '',
    '/',
    '/login',
    '/workspace',
    '/workspaces/org/overview',
    '/workspace-evil/org/overview',
    'https://evil.example/workspace/org/overview',
    'http://workspace.example/workspace/org/overview',
    '//evil.example/workspace/org/overview',
    'https://workspace.example@evil.example/workspace/org/overview',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '\\evil.example\\workspace\\org\\overview',
    '/\\evil.example/workspace/org/overview',
    '/workspace/../../../login',
    '/workspace/%2e%2e/overview',
    '/workspace/org/overview/../../login',
    '/workspace/org%2F..%2F..%2Fexternal/invoices',
    '/workspace/user:pass@evil.example/invoices',
    '/workspace/org/overview%0D%0ALocation:https://evil.example',
    '/workspace/%E0%A4%A/invoices',
    '/workspace/org/invoices/payments',
    '/workspace/org/organizations/delete/id',
  ];
  for (const value of unsafe) assert.equal(safeWorkspaceReturn(value), null, value);
});

test('authentication returns are canonical same-origin workspace URLs with only permitted context', () => {
  const safe = safeWorkspaceReturn(
    '/workspace/%73hri-sarraf/invoices/preview/invoice-1?redirect=https://evil.example&token=secret&role=vendor',
  );
  assert.equal(safe, '/workspace/shri-sarraf/invoices/preview/invoice-1?role=vendor');
  for (const view of WORKSPACE_VIEWS) {
    const value = `/workspace/org-1/${view}?role=javascript%3Aalert(1)&itemType=product&next=%2F%2Fevil.example`;
    const result = safeWorkspaceReturn(value);
    assert.ok(result);
    const url = new URL(result, 'https://workspace.example');
    assert.equal(url.origin, 'https://workspace.example');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    assert.deepEqual(readWorkspaceRoute(url.pathname, url.search), {
      organizationId: 'org-1',
      view: view as WorkspaceView,
      itemType: 'product',
    });
    assert.equal(safeWorkspaceReturn(result), result);
  }
});
