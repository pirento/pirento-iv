/**
 * Contact and catalog pickers in the invoice editor: searches /api/<kind>/lookup page by page and
 * keeps records already used by the draft selected even when they are not in the current results.
 */

import { api } from '../core/api.js';

/** Keep one result page and records referenced by the current draft, never every search result. */
export function replaceDirectoryRows(rows, matches, retainedIds = []) {
  const retained = new Set(retainedIds.filter(Boolean));
  const byId = new Map(rows.filter((item) => retained.has(item.id)).map((item) => [item.id, item]));
  for (const item of matches) byId.set(item.id, item);
  rows.splice(0, rows.length, ...byId.values());
}

/** Loads specific records by ID (50 per request) so a draft's chosen contact/items can be shown. */
export async function fetchDirectoryRecords(kind, organizationId, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const query = new URLSearchParams({ organizationId, ids: unique.slice(offset, offset + 50).join(',') });
      const page = await api(`/${kind}/lookup?${query}`, { signal: controller.signal });
      result.push(...page.items);
    } finally {
      clearTimeout(timer);
    }
  }
  return result;
}

/** Debounced, cancellable requests. An older response cannot overwrite a newer search or division. */
export function createDirectoryPicker({
  kind,
  organizationId,
  parameters,
  initialPage,
  status,
  previous,
  next,
  retry,
  onPage,
  onBusy = () => {},
}) {
  let current = initialPage || { page: 1, pageSize: 20, hasMore: false };
  let requestPage = current.page;
  let generation = 0;
  let controller;
  let debounce;
  const controls = (busy) => {
    previous.disabled = busy || current.page <= 1;
    next.disabled = busy || !current.hasMore;
    onBusy(busy);
  };
  function describe() {
    status.textContent = `Page ${current.page} · up to ${current.pageSize} matches${current.hasMore ? '. More results on the next page.' : '.'}`;
    retry.hidden = true;
    controls(false);
  }
  function search({ page = 1, immediate = false } = {}) {
    requestPage = page;
    const ownGeneration = ++generation;
    clearTimeout(debounce);
    controller?.abort();
    retry.hidden = true;
    status.textContent = 'Searching…';
    controls(true);
    const run = async () => {
      controller = new AbortController();
      const ownController = controller;
      const timer = setTimeout(() => ownController.abort(), 10000);
      try {
        const query = new URLSearchParams({ organizationId, ...parameters(), page: String(page) });
        const result = await api(`/${kind}/lookup?${query}`, { signal: ownController.signal });
        if (ownGeneration !== generation) return;
        current = result;
        onPage(result);
        describe();
      } catch (error) {
        if (ownGeneration !== generation) return;
        status.textContent =
          error.name === 'AbortError'
            ? 'Search timed out. Please retry.'
            : 'Search could not be loaded. Please retry.';
        retry.hidden = false;
        controls(false);
      } finally {
        clearTimeout(timer);
      }
    };
    if (immediate) void run();
    else debounce = setTimeout(run, 180);
  }
  previous.addEventListener('click', () => search({ page: current.page - 1, immediate: true }));
  next.addEventListener('click', () => search({ page: current.page + 1, immediate: true }));
  retry.addEventListener('click', () => search({ page: requestPage, immediate: true }));
  describe();
  return { search };
}
