/** Image upload fields: reads a PNG/JPEG/WebP file (max 500 KB) into an inline data URL with a live preview. */

/** Uploads remain portable data URLs, matching the original 500 KB limit. */
export async function readImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > 500 * 1024) throw new Error('Choose an image smaller than 500 KB.');
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read the selected image.'));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = () => reject(new Error('The file is not a readable image.'));
    image.src = url;
  });
  return url;
}

/** Wires every [data-image-field] in a form: file chooser -> hidden value -> preview image. */
export function bindImageFields(form, onError) {
  form.querySelectorAll('[data-image-field]').forEach((wrapper) => {
    const field = form.elements[wrapper.dataset.imageField];
    const preview = wrapper.querySelector('img');
    const update = () => {
      preview.src = field.value;
      preview.hidden = !field.value;
    };
    field.addEventListener('input', update);
    wrapper.querySelector('[type="file"]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        field.value = await readImage(file);
        update();
        form.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (error) {
        onError(error.message);
      }
      event.target.value = '';
    });
    wrapper.querySelector('[data-clear-image]')?.addEventListener('click', () => {
      field.value = '';
      update();
      form.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}
