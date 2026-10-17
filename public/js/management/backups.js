/** Database backups page (views/backups/index.ejs, admin only): create a backup and refresh its status. */

import { getPageData } from '../core/page.js';
import { api, sendJson, showError, dateTime, setMessage } from './common.js';

const data = getPageData();
const root = document.getElementById('backups-page');
if (data.user.role === 'admin') {
  let status = data.backupStatus || null;
  let backups = data.backups || [];
  let loading = false;
  let creating = false;
  let sequence = 0;
  const refresh = root.querySelector('[data-refresh]');
  const create = root.querySelector('[data-create-backup]');
  const template = document.getElementById('backup-row-template');
  const rows = root.querySelector('[data-backup-rows]');

  function render() {
    const busy = creating || Boolean(status?.running);
    refresh.disabled = loading || creating;
    create.disabled = loading || busy || !status || status.available === false;
    create.textContent = busy ? 'Creating backup…' : 'Create backup';
    root.querySelector('[data-loading]').hidden = Boolean(status) || !loading;
    root.querySelector('[data-backup-details]').hidden = !status;
    if (!status) return;
    root.querySelector('[data-schedule-badge]').textContent = status.enabled ? 'On' : 'Off';
    const minutes = status.intervalMinutes;
    const interval =
      minutes % 60 === 0
        ? `Every ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
        : `Every ${minutes} minutes`;
    root.querySelector('[data-schedule]').textContent = status.enabled ? interval : 'Not enabled';
    root.querySelector('[data-retention]').textContent = status.enabled
      ? `Keeps the latest ${status.retention} completed database snapshots on this server.`
      : 'You can create a manual backup. Enable the schedule in the hosting server configuration.';
    root.querySelector('[data-last-success]').textContent = status.lastSuccessfulAt
      ? dateTime(status.lastSuccessfulAt)
      : 'No completed backup yet';
    const unavailable = status.available === false;
    root.querySelector('[data-storage-badge]').textContent = unavailable ? 'Needs setup' : 'Server';
    root.querySelector('[data-storage]').textContent = unavailable
      ? 'Storage unavailable'
      : 'Private server storage';
    root.querySelector('[data-storage-note]').textContent = unavailable
      ? 'Ask your server administrator to configure writable private backup storage.'
      : status.remoteConfigured
        ? 'Remote backup storage is configured on the server.'
        : 'Offsite backup is not configured. Download a copy and keep it in secure storage outside this server.';
    root.querySelector('[data-last-failure]').hidden = !status.lastFailure;
    root.querySelector('[data-backup-count]').textContent =
      `${backups.length} ${backups.length === 1 ? 'backup' : 'backups'}`;
    root.querySelector('[data-empty]').hidden = backups.length > 0;
    root.querySelector('[data-backup-table]').hidden = backups.length === 0;
  }

  function renderRows() {
    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    rows.replaceChildren(
      ...backups.map((backup) => {
        const row = template.content.firstElementChild.cloneNode(true);
        row.dataset.backupRow = backup.id;
        const date = row.querySelector('[data-backup-date]');
        date.textContent = dateTime(backup.createdAt);
        date.dateTime = backup.createdAt;
        row.querySelector('[data-backup-id]').textContent = backup.id;
        const bytes = Number(backup.byteLength || 0);
        row.querySelector('[data-backup-size]').textContent =
          bytes < 1024
            ? `${bytes} B`
            : bytes < 1024 * 1024
              ? `${(bytes / 1024).toFixed(1)} KB`
              : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        row.querySelector('[data-backup-download]').href =
          `/api/backups/${encodeURIComponent(backup.id)}/download`;
        row.querySelector('[data-backup-manifest]').href =
          `/api/backups/${encodeURIComponent(backup.id)}/manifest`;
        return row;
      }),
    );
  }

  async function load() {
    const request = ++sequence;
    loading = true;
    showError('', root);
    render();
    try {
      const [nextStatus, nextBackups] = await Promise.all([api('/backups/status'), api('/backups')]);
      if (request !== sequence) return;
      status = nextStatus;
      backups = nextBackups;
      renderRows();
    } catch (error) {
      if (request === sequence) showError(error.message, root);
    } finally {
      if (request === sequence) {
        loading = false;
        render();
      }
    }
  }
  create.addEventListener('click', async () => {
    if (creating || loading || !status || status.running || status.available === false) return;
    creating = true;
    showError('', root);
    setMessage(root.querySelector('[data-notice]'), '');
    render();
    try {
      const saved = await api('/backups', sendJson('POST'));
      backups = [saved, ...backups.filter((backup) => backup.id !== saved.id)];
      renderRows();
      setMessage(
        root.querySelector('[data-notice]'),
        saved.retentionWarning
          ? 'Backup created. Older backup cleanup needs attention on the server.'
          : 'Database backup created. You can download the completed snapshot below.',
      );
      await load();
    } catch (error) {
      showError(error.message, root);
    } finally {
      creating = false;
      render();
    }
  });
  refresh.addEventListener('click', load);
  render();
  if (!status) void load();
}
