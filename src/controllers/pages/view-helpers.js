import * as types from '../../../shared/types.js';
import * as pdf from '../../../shared/pdf.js';
import * as billing from '../../../shared/billing-presets.js';
import * as presets from '../../../shared/template-presets.js';
import * as identity from '../../../shared/business-identity.js';
import * as contacts from '../../../shared/contact-types.js';
import { workspaceUrl } from '../../../public/js/core/workspace-route.js';
import { documentStatus } from '../../../shared/document-status.js';

export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function displayDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(date)
    : '—';
}
export function displayDateTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : 'Not available';
}
export const statusOf = documentStatus;
export const documentViews = {
  invoice: 'invoices',
  quotation: 'quotations',
  proforma: 'proformas',
  delivery_note: 'shipping',
};
export function safeImage(value = '') {
  return (
    /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(value) || /^https:\/\/[^\s]+$/i.test(value)
  );
}
export const initials = (value) =>
  String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
export const url = (data, view, action, id, extra = {}) =>
  workspaceUrl({
    organizationId: data.route.organizationId,
    view,
    ...(action ? { action } : {}),
    ...(id ? { id } : {}),
    ...extra,
  });

/** Page filters stay in the URL; values are encoded before EJS escapes the attribute. */
export function pageUrl(data, view, query = {}, action, id) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const path = url(data, view, action, id);
  return `${path}${params.size ? `?${params}` : ''}`;
}

const iconPaths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  document:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  people:
    '<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M16 3a4 4 0 0 1 0 8M22 21v-3a6 6 0 0 0-4-5"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5zM3 8v9l9 5 9-5V8M12 13v9M7 5l9 5"/>',
  building:
    '<rect x="5" y="3" width="14" height="19" rx="1"/><path d="M9 7h1m4 0h1m-6 4h1m4 0h1M9 22v-7h6v7"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  archive: '<path d="M4 8v13h16V8M3 3h18v5H3zM9 12h6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
};
function icon(name) {
  return `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || iconPaths.document}</svg>`;
}

function navigation(data) {
  const groups = [
    {
      label: 'Workspace',
      items: [
        { view: 'overview', label: 'Overview', icon: 'grid' },
        { view: 'invoices', label: 'Invoices', icon: 'document' },
        { view: 'quotations', label: 'Quotations', icon: 'document' },
        { view: 'proformas', label: 'Proforma invoices', icon: 'document' },
        { view: 'shipping', label: 'Delivery challans', icon: 'box' },
      ],
    },
    {
      label: 'Receivables',
      items: [
        { view: 'ledger', label: 'Customer ledger', icon: 'document' },
        { view: 'reminders', label: 'Payment reminders', icon: 'people' },
        { view: 'recurring', label: 'Recurring invoices', icon: 'archive' },
      ],
    },
    {
      label: 'Manage',
      items: [
        { view: 'customers', label: 'Contacts', icon: 'people' },
        { view: 'catalog', label: 'Products & services', icon: 'box' },
        ...(data.organization?.enableProductSelection ||
        billing.billingProfileFor(data.organization || { name: '' }) === 'ecosystem'
          ? [{ view: 'business_products', label: 'Business products', icon: 'grid' }]
          : []),
        { view: 'formats', label: 'Document formats', icon: 'document' },
        { view: 'organizations', label: 'Businesses', icon: 'building' },
      ],
    },
  ];
  if (data.user.role === 'admin')
    groups.push({
      label: 'Administration',
      items: [
        { view: 'business_settings', label: 'Business settings', icon: 'settings' },
        { view: 'dashboard_branding', label: 'Workspace branding', icon: 'settings' },
        { view: 'team', label: 'Team access', icon: 'people' },
        { view: 'security', label: 'Security activity', icon: 'shield' },
        { view: 'integrations', label: 'Payments & email', icon: 'settings' },
        { view: 'backups', label: 'Database backups', icon: 'archive' },
      ],
    });
  groups.push({
    label: 'Account',
    items: [{ view: 'sessions', label: 'My sessions', icon: 'shield' }],
  });
  return groups;
}

export const helpers = {
  ...types,
  ...pdf,
  ...billing,
  ...presets,
  ...identity,
  ...contacts,
  types,
  pdf,
  today,
  displayDate,
  displayDateTime,
  statusOf,
  safeImage,
  initials,
  url,
  pageUrl,
  icon,
  navigation,
  workspaceUrl,
  documentViews,
  statusLabel: (status) => (status === 'overdue' ? 'Overdue' : types.STATUS_LABELS[status] || status),
  escapeHtml: (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    ),
  json: (value) =>
    JSON.stringify(value).replace(
      /[<>&\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
};
