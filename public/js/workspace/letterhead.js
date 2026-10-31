/** Letterhead page (views/letterhead/index.ejs): choose the image, mark the blank area, save or remove. */

import { api, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast } from '../core/page.js';
import { readImage } from '../core/images.js';

const data = getPageData();
const organizationId = encodeURIComponent(data.organization.id);
const form = document.querySelector('[data-letterhead-form]');
const preview = document.querySelector('[data-letterhead-preview]');
const area = document.querySelector('[data-letterhead-area]');
let image = data.letterhead?.image ?? '';

// A4 portrait is 210 x 297 mm; the box is drawn in percent of the page.
function showArea() {
  const value = (name) => Number(form.elements[name].value) || 0;
  area.style.top = `${(value('top') / 297) * 100}%`;
  area.style.bottom = `${(value('bottom') / 297) * 100}%`;
  area.style.left = `${(value('left') / 210) * 100}%`;
  area.style.right = `${(value('right') / 210) * 100}%`;
}

function reloadWithMessage(message) {
  try {
    rememberToast(message);
  } catch {
    /* Saved work is not changed by unavailable browser storage. */
  }
  location.reload();
}

form.addEventListener('input', showArea);
form.querySelector('[data-letterhead-file]').addEventListener('change', async (event) => {
  showError(form, '');
  try {
    image = await readImage(event.target.files[0], { maxKb: 1536, types: ['image/png', 'image/jpeg'] });
    preview.style.backgroundImage = `url("${image}")`;
  } catch (error) {
    showError(form, error.message);
  }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  if (!image) return showError(form, 'Choose the letterhead image first.');
  showError(form, '');
  setBusy(button, true, 'Saving…');
  try {
    const value = (name) => Number(form.elements[name].value);
    await api(
      `/letterheads/${organizationId}`,
      sendJson('PUT', {
        image,
        top: value('top'),
        bottom: value('bottom'),
        left: value('left'),
        right: value('right'),
        defaultOn: form.elements.defaultOn.checked,
      }),
    );
    reloadWithMessage('Letterhead saved.');
  } catch (error) {
    showError(form, error.message);
    setBusy(button, false);
  }
});
document.querySelector('[data-letterhead-remove]')?.addEventListener('click', async (event) => {
  if (!confirm('Remove this letterhead? Documents already saved on it keep their copy.')) return;
  setBusy(event.target, true, 'Removing…');
  try {
    await api(`/letterheads/${organizationId}`, sendJson('DELETE'));
    reloadWithMessage('Letterhead removed.');
  } catch (error) {
    showError(form, error.message);
    setBusy(event.target, false);
  }
});
showArea();
