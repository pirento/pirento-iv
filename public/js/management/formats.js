import { getPageData, rememberToast } from '../core/page.js';
import { defaultFormatFor } from '/shared/types.js';
import { documentColors } from '/shared/pdf.js';
import { TEMPLATE_PRESETS } from '/shared/template-presets.js';
import {
  api,
  sendJson,
  asInput,
  showError,
  withBusy,
  preserveReturnLinks,
  afterSave,
  readLogo,
} from './common.js';

const data = getPageData();
const root = document.getElementById('formats-page');
const organization = data.organization;
const formats = (data.formats || []).filter((format) => format.organizationId === organization.id);
preserveReturnLinks();
const form = document.getElementById('format-form');
const booleanFields = [
  'showLogo',
  'showHsn',
  'showUnit',
  'showGstRate',
  'showBankDetails',
  'showAmountInWords',
  'showSignature',
  'showSecondarySignature',
  'showStamp',
  'showPaymentQr',
  'isDefault',
];
const numberFields = [
  'fontSize',
  'pageMargin',
  'logoWidth',
  'signatureWidth',
  'stampWidth',
  'paymentQrWidth',
];
const stringFields = [
  'name',
  'description',
  'presetKey',
  'layout',
  'accentColor',
  'density',
  'pageSize',
  'orientation',
  'tableStyle',
  'logoUrl',
  'footerText',
];

if (form) {
  const value = (key) => form.elements.namedItem(key)?.value || '';
  let previousPreset = value('presetKey');
  const source = formats.find((format) => format.id === (data.route.id || data.route.entityId));

  function readFormat() {
    const input = {
      ...asInput(defaultFormatFor(organization)),
      ...(source ? asInput(source) : {}),
      organizationId: organization.id,
    };
    for (const key of stringFields) input[key] = value(key);
    for (const key of numberFields) input[key] = Number(value(key));
    for (const key of booleanFields) input[key] = form.elements.namedItem(key).checked;
    return input;
  }

  function writeFormat(input) {
    for (const key of [...stringFields, ...numberFields, ...booleanFields]) {
      form.querySelectorAll(`[name="${key}"]`).forEach((control) => {
        if (control.type === 'radio') control.checked = control.value === input[key];
        else if (control.type === 'checkbox') control.checked = Boolean(input[key]);
        else control.value = input[key] ?? '';
      });
    }
  }

  function updatePreview() {
    const format = readFormat();
    const sample = form.querySelector('[data-format-sample]');
    const colors = documentColors(format.accentColor);
    sample.className = `fmt-sample fmt-sample-${format.layout} fmt-density-${format.density} fmt-table-${format.tableStyle || 'ruled'} fmt-paper-${(format.pageSize || 'A4').toLowerCase()} fmt-paper-${format.orientation || 'portrait'}`;
    const styles = {
      '--fmt-accent': colors.accent,
      '--fmt-on-accent': colors.onAccent,
      '--fmt-accent-text': colors.accentText,
      '--fmt-body-font': `${format.fontSize * 0.75}px`,
      '--fmt-brand-font': `${format.fontSize * 1.25}px`,
      '--fmt-heading-font': `${format.fontSize * 1.45}px`,
      '--fmt-paper-margin': `${format.pageMargin * 1.6}px`,
      '--fmt-logo-size': `${format.logoWidth * 0.58}px`,
      '--fmt-signature-size': `${format.signatureWidth * 0.55}px`,
      '--fmt-stamp-size': `${format.stampWidth * 0.55}px`,
      '--fmt-qr-size': `${format.paymentQrWidth * 0.55}px`,
    };
    for (const [property, setting] of Object.entries(styles)) sample.style.setProperty(property, setting);
    sample.querySelectorAll('[data-sample-show]').forEach((element) => {
      element.hidden = !format[element.dataset.sampleShow];
    });
    const logo = format.logoUrl || organization.logoUrl;
    const image = sample.querySelector('[data-sample-logo]');
    image.hidden = !logo;
    if (logo) image.src = logo;
    else image.removeAttribute('src');
    sample.querySelector('[data-sample-monogram]').hidden = Boolean(logo);
    const footer = sample.querySelector('[data-sample-footer]');
    footer.textContent = format.footerText;
    footer.hidden = !format.footerText;
    form.querySelector('[data-paper-label]').textContent =
      `${format.pageSize} · ${format.orientation} · ${format.fontSize} pt`;
    form.querySelectorAll('[data-range-output]').forEach((output) => {
      const control = form.elements.namedItem(output.dataset.rangeOutput);
      output.textContent = `${control.value} ${control.dataset.rangeUnit}`;
    });
    form.querySelectorAll('[data-visible-when]').forEach((element) => {
      element.hidden = !format[element.dataset.visibleWhen];
    });
    form.querySelector('[data-color-value]').textContent = format.accentColor.toUpperCase();
    form
      .querySelectorAll('[data-color]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.color === format.accentColor)),
      );
    form.querySelector('[data-remove-logo]').hidden = !format.logoUrl;
  }

  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  form.querySelectorAll('[data-color]').forEach((button) =>
    button.addEventListener('click', () => {
      form.elements.namedItem('accentColor').value = button.dataset.color;
      updatePreview();
    }),
  );
  form.elements.namedItem('presetKey').addEventListener('change', (event) => {
    const preset = TEMPLATE_PRESETS.find((preset) => preset.key === event.target.value);
    if (preset) {
      const current = readFormat();
      const previousName = TEMPLATE_PRESETS.find((preset) => preset.key === previousPreset)?.name;
      writeFormat({
        ...asInput(defaultFormatFor(organization)),
        ...preset.settings,
        name: !current.name || current.name === previousName ? preset.name : current.name,
        description: preset.description,
        presetKey: preset.key,
        logoUrl: current.logoUrl,
        isDefault: current.isDefault,
      });
    }
    previousPreset = event.target.value;
    updatePreview();
  });
  form.elements.namedItem('logoFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    showError('', form);
    await withBusy(form, async () => {
      try {
        form.elements.namedItem('logoUrl').value = await readLogo(file);
        form.elements.namedItem('showLogo').checked = true;
        form.querySelector('[data-upload-name]').textContent = file.name;
        updatePreview();
      } catch (error) {
        showError(error.message, form);
      }
    });
  });
  form.querySelector('[data-remove-logo]').addEventListener('click', () => {
    form.elements.namedItem('logoUrl').value = '';
    form.querySelector('[data-upload-name]').textContent = organization.logoUrl
      ? 'Using organization logo'
      : 'No logo added yet';
    updatePreview();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = readFormat();
    input.name = input.name.trim();
    input.description = input.description.trim();
    input.footerText = input.footerText.trim();
    if (!input.name) {
      showError('Give your format a name so you can find it later.', form);
      return;
    }
    showError('', form);
    await withBusy(form, async () => {
      try {
        const id = form.dataset.id;
        const saved = await api(
          id ? `/formats/${encodeURIComponent(id)}` : '/formats',
          sendJson(id ? 'PUT' : 'POST', input),
        );
        afterSave(form.dataset.base, 'formatId', saved);
      } catch (error) {
        showError(error.message, form);
      }
    });
  });
  updatePreview();
} else {
  const deleteButton = root.querySelector('[data-delete-format]');
  deleteButton?.addEventListener('click', async () => {
    if (deleteButton.disabled) return;
    showError('', root);
    await withBusy(root, async () => {
      try {
        await api(`/formats/${encodeURIComponent(deleteButton.dataset.deleteFormat)}`, sendJson('DELETE'));
        rememberToast('Format deleted. Saved documents keep their design.');
        location.assign(deleteButton.dataset.base);
      } catch (error) {
        showError(error.message, root);
      }
    });
  });
  const search = root.querySelector('[data-search]');
  if (search) {
    let category = 'All formats';
    function render() {
      const query = search.value.trim().toLowerCase();
      const visible = new Set(
        formats
          .filter((format) => {
            const preset = TEMPLATE_PRESETS.find((preset) => preset.key === format.presetKey);
            const formatCategory = preset?.category || 'Custom';
            return (
              (category === 'All formats' || category === formatCategory) &&
              `${format.name} ${format.description || preset?.description || ''} ${format.layout} ${formatCategory}`
                .toLowerCase()
                .includes(query)
            );
          })
          .map((format) => format.id),
      );
      root.querySelectorAll('[data-format-row]').forEach((card) => {
        card.hidden = !visible.has(card.dataset.formatRow);
      });
      root
        .querySelectorAll('[data-category]')
        .forEach((button) =>
          button.setAttribute('aria-pressed', String(button.dataset.category === category)),
        );
      root.querySelector('[data-empty]').hidden = visible.size > 0;
      root.querySelector('[data-results]').textContent =
        `${visible.size} ${visible.size === 1 ? 'format' : 'formats'}${category !== 'All formats' ? ` in ${category.toLowerCase()}` : ''}${query ? ` matching “${search.value.trim()}”` : ''}`;
    }
    search.addEventListener('input', render);
    root.querySelectorAll('[data-category]').forEach((button) =>
      button.addEventListener('click', () => {
        category = button.dataset.category;
        render();
      }),
    );
    root.querySelector('[data-show-all]').addEventListener('click', () => {
      category = 'All formats';
      search.value = '';
      render();
    });
    root.querySelectorAll('[data-delete-link]').forEach((anchor) =>
      anchor.addEventListener('click', (event) => {
        if (anchor.getAttribute('aria-disabled') === 'true') event.preventDefault();
      }),
    );
    root.querySelectorAll('[data-make-default]').forEach((button) =>
      button.addEventListener('click', async () => {
        const format = formats.find((format) => format.id === button.dataset.makeDefault);
        if (!format || format.isDefault) return;
        showError('', root);
        await withBusy(root, async () => {
          try {
            await api(
              `/formats/${encodeURIComponent(format.id)}`,
              sendJson('PUT', { ...asInput(format), isDefault: true }),
            );
            rememberToast('Default invoice format saved');
            location.reload();
          } catch (error) {
            showError(error.message, root);
          }
        });
      }),
    );
    render();
  }
}
