/** Business products page (views/business-products/index.ejs): live preview card, logo upload and save/archive. */

import { getPageData } from '../core/page.js';
import {
  api,
  sendJson,
  asInput,
  showError,
  showToast,
  withBusy,
  preserveReturnLinks,
  afterSave,
  readLogo,
  initials,
} from './common.js';

const data = getPageData();
const root = document.getElementById('business-products-page');
const organization = data.organization;
preserveReturnLinks();
const form = document.getElementById('business-product-form');

if (form) {
  const value = (key) => form.elements.namedItem(key).value;
  const updatePreview = () => {
    const logo = value('logoUrl');
    const image = form.querySelector('[data-logo-preview]');
    image.hidden = !logo;
    if (logo) image.src = logo;
    else image.removeAttribute('src');
    const monogram = form.querySelector('[data-initials]');
    monogram.hidden = Boolean(logo);
    monogram.textContent = initials(value('name'));
    form.querySelector('[data-preview-name]').textContent = value('name') || 'Your business product';
    form.querySelector('[data-preview-code]').textContent = value('code') || organization.name;
    form.querySelector('[data-preview-active]').textContent = form.elements.namedItem('active').checked
      ? 'Active'
      : 'Archived';
    form.querySelector('[data-description-count]').textContent = `${value('description').length}/2000`;
    form.querySelector('[data-remove-logo]').hidden = !logo;
  };
  form.addEventListener('input', updatePreview);
  form.elements.namedItem('logoFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    showError('', form);
    await withBusy(form, async () => {
      try {
        form.elements.namedItem('logoUrl').value = await readLogo(file);
        form.querySelector('[data-upload-name]').textContent = file.name;
        updatePreview();
      } catch (error) {
        showError(error.message, form);
      }
    });
  });
  form.querySelector('[data-remove-logo]').addEventListener('click', () => {
    form.elements.namedItem('logoUrl').value = '';
    form.querySelector('[data-upload-name]').textContent = '';
    updatePreview();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = {
      organizationId: organization.id,
      name: value('name').trim(),
      code: value('code').trim(),
      description: value('description').trim(),
      logoUrl: value('logoUrl'),
      active: form.elements.namedItem('active').checked,
    };
    if (!input.name) {
      showError('Enter a name for this business product.', form);
      return;
    }
    showError('', form);
    await withBusy(form, async () => {
      try {
        const id = form.dataset.id;
        const saved = await api(
          id ? `/business-products/${encodeURIComponent(id)}` : '/business-products',
          sendJson(id ? 'PUT' : 'POST', input),
        );
        afterSave(form.dataset.base, 'businessProductId', saved);
      } catch (error) {
        showError(error.message, form);
      }
    });
  });
} else if (root.querySelector('[data-search]')) {
  let products = (data.businessProducts || []).filter(
    (product) => product.organizationId === organization.id,
  );
  let filter = 'active';
  const search = root.querySelector('[data-search]');
  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = new Set(
      products
        .filter(
          (product) =>
            (filter === 'all' || product.active === (filter === 'active')) &&
            `${product.name} ${product.code} ${product.description}`.toLowerCase().includes(query),
        )
        .map((product) => product.id),
    );
    root.querySelectorAll('[data-product-row]').forEach((row) => {
      row.hidden = !visible.has(row.dataset.productRow);
    });
    root.querySelectorAll('[data-count]').forEach((element) => {
      const key = element.dataset.count;
      element.textContent = products.filter(
        (product) => key === 'all' || product.active === (key === 'active'),
      ).length;
    });
    root
      .querySelectorAll('[data-filter]')
      .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
    root.querySelector('[data-empty]').hidden = visible.size > 0;
  }
  search.addEventListener('input', render);
  root.querySelectorAll('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      render();
    }),
  );
  root.querySelectorAll('[data-archive]').forEach((button) =>
    button.addEventListener('click', async () => {
      const product = products.find((product) => product.id === button.dataset.archive);
      if (!product) return;
      showError('', root);
      await withBusy(root, async () => {
        try {
          const saved = await api(
            `/business-products/${encodeURIComponent(product.id)}`,
            sendJson('PUT', { ...asInput(product), active: !product.active }),
          );
          products = products.map((product) => (product.id === saved.id ? saved : product));
          button.textContent = saved.active ? 'Archive' : 'Restore';
          showToast(saved.active ? 'Business product restored' : 'Business product archived');
          button.closest('[data-product-row]').querySelector('[data-product-status]').textContent =
            saved.active ? 'Active' : 'Archived';
        } catch (error) {
          showError(error.message, root);
        }
      });
      render();
    }),
  );
  render();
}
