/**
 * Catalog page (views/catalog/index.ejs): add/edit a product or service (including its pricing
 * method), list filters, CSV export and archive/restore.
 */

import { getPageData, rememberToast } from '../core/page.js';
import { bindDirectoryFilters } from '../core/directory-filters.js';
import { calculateLineAmount } from '/shared/types.js';
import { api, sendJson, asInput, showError, withBusy, preserveReturnLinks, afterSave } from './common.js';
import { bindPricing, readPricing, validatePricing } from './pricing.js';

const data = getPageData();
const root = document.getElementById('catalog-page');
const organization = data.organization;
preserveReturnLinks();

const form = document.getElementById('catalog-form');
if (form) {
  bindPricing(form);
  form.elements.namedItem('hsn').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '');
  });
  form.querySelectorAll('[name="type"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      const unit = form.elements.namedItem('unit');
      if (['Service', 'Nos'].includes(unit.value)) unit.value = radio.value === 'service' ? 'Service' : 'Nos';
      unit.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const input = {
      organizationId: organization.id,
      type: values.type,
      name: String(values.name || '').trim(),
      description: String(values.description || '').trim(),
      sku: String(values.sku || '').trim(),
      hsn: String(values.hsn || '').trim(),
      unit: String(values.unit || '').trim(),
      rate: Number(values.rate),
      gstRate: Number(values.gstRate),
      active: form.dataset.active !== 'false',
      businessProductId: values.businessProductId || '',
      pricing: readPricing(form),
    };
    let error = '';
    if (!input.name || !input.unit) error = 'Add a name and unit for this item.';
    else if (input.hsn && !/^\d{4,8}$/.test(input.hsn))
      error = 'HSN / SAC must contain 4–8 digits, or can be left blank.';
    else if (
      values.rate === '' ||
      values.gstRate === '' ||
      ![input.rate, input.gstRate].every(Number.isFinite) ||
      input.rate < 0 ||
      input.gstRate < 0 ||
      input.gstRate > 40
    )
      error = 'Enter a valid price and GST rate (0–40%).';
    else error = validatePricing(input.pricing);
    if (!error && calculateLineAmount({ quantity: 1, rate: input.rate, pricing: input.pricing }) > 1000000000)
      error = 'The calculated amount for one item cannot exceed ₹100 crore.';
    showError(error, form);
    if (error) return;
    await withBusy(form, async () => {
      try {
        const id = form.dataset.id;
        const saved = await api(
          id ? `/catalog/${encodeURIComponent(id)}` : '/catalog',
          sendJson(id ? 'PUT' : 'POST', input),
        );
        afterSave(form.dataset.base, 'catalogId', saved);
      } catch (error) {
        showError(error.message, form);
      }
    });
  });
} else if (root.querySelector('[data-search]')) {
  const items = data.catalog || [];
  bindDirectoryFilters(
    root.querySelector('[data-directory-filters]'),
    root.querySelector('[data-export]'),
    organization.id,
    'catalog',
  );
  const selectedProduct = data.directory?.filters.product;
  if ((data.businessProducts || []).some((product) => product.id === selectedProduct && product.active)) {
    root.querySelectorAll('[data-add-item]').forEach((anchor) => {
      const target = new URL(anchor.href, location.origin);
      target.searchParams.set('businessProductId', selectedProduct);
      anchor.href = target.pathname + target.search;
    });
  }
  root.querySelectorAll('[data-archive]').forEach((button) =>
    button.addEventListener('click', async () => {
      const item = items.find((item) => item.id === button.dataset.archive);
      if (!item) return;
      showError('', root);
      await withBusy(root, async () => {
        try {
          const saved = await api(
            `/catalog/${encodeURIComponent(item.id)}`,
            sendJson('PUT', { ...asInput(item), active: !item.active }),
          );
          rememberToast(saved.active ? 'Item restored' : 'Item archived');
          location.assign(location.pathname + location.search);
        } catch (error) {
          showError(error.message, root);
        }
      });
    }),
  );
}
