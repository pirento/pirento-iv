/** Unit tests: the synthetic preview's link guard (public/js/core/preview-navigation.js). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPreviewLink } from '../public/js/core/preview-navigation.js';

const currentUrl = 'https://preview.example/workspace/test-org/invoices';

test('preview navigation preserves organization routes, query strings and local anchors', () => {
  for (const href of [
    '/workspace/test-org/customers/new',
    '/workspace/another-org/invoices?status=draft',
    '?status=paid',
    '#invoice-items',
    'https://preview.example/workspace/test-org/invoices/preview/doc-1',
    'https://preview.example:443/login',
    '//preview.example/signup',
  ])
    assert.equal(isAllowedPreviewLink(href, currentUrl), true, href);
});

test('preview PDF and database exports permit local blob URLs only as downloads', () => {
  const blob = 'blob:https://preview.example/37eb8a12-7a99-4497-9c0c-c84de245e179';
  assert.equal(isAllowedPreviewLink(blob, currentUrl, true), true);
  assert.equal(isAllowedPreviewLink(blob, currentUrl), false);
  assert.equal(isAllowedPreviewLink('blob:https://other.example/export', currentUrl, true), false);
  assert.equal(isAllowedPreviewLink('blob:null/export', currentUrl, true), false);
});

test('preview navigation prevents remote destinations and protocol or port changes', () => {
  for (const href of [
    'https://dashboard.razorpay.com/',
    'https://preview.example.evil.example/',
    '//other.example/path',
    'http://preview.example/login',
    'https://preview.example:444/login',
    'https://preview.example@other.example/',
    'https://other.example@preview.example.evil.example/',
  ]) {
    assert.equal(isAllowedPreviewLink(href, currentUrl), false, href);
    assert.equal(isAllowedPreviewLink(href, currentUrl, true), false, href);
  }
});

test('credential-bearing links cannot pass a same-origin check, including embedded blob URLs', () => {
  for (const href of [
    'https://user@preview.example/login',
    'https://user:password@preview.example/login',
    'https://:password@preview.example/login',
    'https://user%40example.com:pass%40word@preview.example/login',
    'blob:https://user:password@preview.example/export',
  ]) {
    assert.equal(isAllowedPreviewLink(href, currentUrl), false, href);
    assert.equal(isAllowedPreviewLink(href, currentUrl, true), false, href);
  }
});

test('unsupported schemes and malformed URLs are blocked without executing or throwing', () => {
  for (const href of [
    'mailto:support@pirento.com',
    'tel:+911234567890',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/workspace.sqlite',
    'ftp://preview.example/export',
    'https://[invalid-ipv6]/',
    'https://preview.example:invalid/',
    'https://%',
  ]) {
    assert.equal(isAllowedPreviewLink(href, currentUrl), false, href);
    assert.equal(isAllowedPreviewLink(href, currentUrl, true), false, href);
  }
  assert.equal(isAllowedPreviewLink('/workspace/test-org', 'invalid current URL'), false);
});
