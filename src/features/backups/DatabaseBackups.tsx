import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock3,
  Download,
  FileJson,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import type { AuthUser } from '../../../shared/auth-types';
import './backups.css';

interface BackupStatus {
  available?: boolean;
  enabled: boolean;
  intervalMinutes: number;
  retention: number;
  running: boolean;
  lastSuccessfulAt: string | null;
  lastFailure: boolean;
  location: 'private_server_storage';
  remoteConfigured: boolean;
}

interface BackupMetadata {
  id: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  sqliteUserVersion: number;
  schemaVersion: 1;
  verified: true;
  retentionWarning?: string;
}

const displayDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(value))
    : 'No completed backup yet';

function displaySize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayInterval(minutes: number) {
  return minutes % 60 === 0
    ? `Every ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
    : `Every ${minutes} minutes`;
}

export default function DatabaseBackups({ currentUser }: { currentUser: AuthUser }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestSequence = useRef(0);
  const active = useRef(false);
  const isAdmin = currentUser.role === 'admin';

  const load = useCallback(async () => {
    if (!isAdmin) return;
    const request = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const [nextStatus, nextBackups] = await Promise.all([
        api<BackupStatus>('/backups/status'),
        api<BackupMetadata[]>('/backups'),
      ]);
      if (!active.current || request !== requestSequence.current) return;
      setStatus(nextStatus);
      setBackups([...nextBackups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (err) {
      if (active.current && request === requestSequence.current)
        setError(err instanceof Error ? err.message : 'Could not load database backups.');
    } finally {
      if (active.current && request === requestSequence.current) setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      requestSequence.current++;
    };
  }, [load]);

  async function createBackup() {
    if (!isAdmin || creating || loading || !status || status.running || status.available === false) return;
    setCreating(true);
    setError('');
    setNotice('');
    try {
      const saved = await api<BackupMetadata>('/backups', sendJson('POST'));
      if (!active.current) return;
      setBackups((current) => [saved, ...current.filter((backup) => backup.id !== saved.id)]);
      setNotice(
        saved.retentionWarning
          ? 'Backup created. Older backup cleanup needs attention on the server.'
          : 'Database backup created. You can download the completed snapshot below.',
      );
      await load();
    } catch (err) {
      if (active.current)
        setError(err instanceof Error ? err.message : 'Could not create a database backup.');
    } finally {
      if (active.current) setCreating(false);
    }
  }

  if (!isAdmin)
    return (
      <div className="backup-empty" role="status">
        <ShieldCheck size={26} />
        <h2>Administrator access required</h2>
        <p>Database backups are available to workspace administrators.</p>
      </div>
    );

  const busy = creating || Boolean(status?.running);
  const storageUnavailable = status?.available === false;
  return (
    <div className="database-backups">
      <section className="backup-intro" aria-labelledby="backup-intro-title">
        <div>
          <span className="page-eyebrow">WORKSPACE ADMINISTRATION</span>
          <h2 id="backup-intro-title">Back up every organization’s records</h2>
          <p>
            Each database snapshot includes all organizations, contacts, invoices, payments and account
            settings. Uploaded logos, signatures and other files need their own backup.
          </p>
        </div>
        <div className="backup-actions">
          <button className="button secondary" onClick={() => void load()} disabled={loading || creating}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            Refresh
          </button>
          <button
            className="button primary"
            onClick={() => void createBackup()}
            disabled={loading || busy || !status || storageUnavailable}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Archive size={16} />}
            {busy ? 'Creating backup…' : 'Create backup'}
          </button>
        </div>
      </section>

      {error && (
        <div className="backup-message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="backup-message success" role="status">
          <CheckCircle2 size={17} />
          {notice}
        </div>
      )}

      {loading && !status ? (
        <div className="backup-empty" role="status">
          <LoaderCircle size={26} className="spin" />
          <p>Checking database backups…</p>
        </div>
      ) : (
        status && (
          <>
            <div className="backup-summary">
              <section className="backup-summary-card">
                <div className="backup-summary-heading">
                  <Clock3 size={20} />
                  <h3>Automatic schedule</h3>
                  <span className={`backup-badge ${status.enabled ? 'ready' : ''}`}>
                    {status.enabled ? 'On' : 'Off'}
                  </span>
                </div>
                <strong>{status.enabled ? displayInterval(status.intervalMinutes) : 'Not enabled'}</strong>
                <p>
                  {status.enabled
                    ? `Keeps the latest ${status.retention} completed database snapshots on this server.`
                    : 'You can create a manual backup. Enable the schedule in the hosting server configuration.'}
                </p>
              </section>
              <section className="backup-summary-card">
                <div className="backup-summary-heading">
                  <CheckCircle2 size={20} />
                  <h3>Last successful backup</h3>
                </div>
                <strong>{displayDate(status.lastSuccessfulAt)}</strong>
                <p>Backup dates and times are shown in India Standard Time.</p>
              </section>
              <section className="backup-summary-card">
                <div className="backup-summary-heading">
                  <HardDrive size={20} />
                  <h3>Backup storage</h3>
                  <span className={`backup-badge ${storageUnavailable ? '' : 'ready'}`}>
                    {storageUnavailable ? 'Needs setup' : 'Server'}
                  </span>
                </div>
                <strong>{storageUnavailable ? 'Storage unavailable' : 'Private server storage'}</strong>
                <p>
                  {storageUnavailable
                    ? 'Ask your server administrator to configure writable private backup storage.'
                    : status.remoteConfigured
                      ? 'Remote backup storage is configured on the server.'
                      : 'Offsite backup is not configured. Download a copy and keep it in secure storage outside this server.'}
                </p>
              </section>
            </div>

            {status.lastFailure && (
              <div className="backup-message warning" role="alert">
                The last backup attempt failed. Check the server’s backup configuration before trying again.
              </div>
            )}

            <section className="backup-history" aria-labelledby="backup-history-title" aria-busy={loading}>
              <div className="backup-section-heading">
                <div>
                  <h2 id="backup-history-title">Completed snapshots</h2>
                  <p>
                    {backups.length} {backups.length === 1 ? 'backup' : 'backups'} available · Administrators
                    only
                  </p>
                </div>
                <ShieldCheck size={20} aria-hidden="true" />
              </div>
              {backups.length ? (
                <div className="backup-table-wrapper">
                  <table className="backup-table">
                    <thead>
                      <tr>
                        <th scope="col">Created · IST</th>
                        <th scope="col">Size</th>
                        <th scope="col">Status</th>
                        <th scope="col">Download</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((backup) => (
                        <tr key={backup.id}>
                          <td data-label="Created · IST">
                            <time dateTime={backup.createdAt}>{displayDate(backup.createdAt)}</time>
                            <span className="backup-id">{backup.id}</span>
                          </td>
                          <td data-label="Size">{displaySize(backup.byteLength)}</td>
                          <td data-label="Status">
                            <span className="backup-badge ready">
                              <CheckCircle2 size={12} /> Completed
                            </span>
                          </td>
                          <td>
                            <div className="backup-download-actions">
                              <a
                                className="button secondary backup-download"
                                href={`/api/backups/${encodeURIComponent(backup.id)}/download`}
                                download
                                aria-label={`Download database backup from ${displayDate(backup.createdAt)}`}
                              >
                                <Download size={14} /> Download
                              </a>
                              <a
                                className="button secondary backup-download"
                                href={`/api/backups/${encodeURIComponent(backup.id)}/manifest`}
                                download
                                aria-label={`Download manifest for backup from ${displayDate(backup.createdAt)}`}
                              >
                                <FileJson size={14} /> Manifest
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="backup-empty">
                  <Archive size={28} />
                  <h3>No completed backups</h3>
                  <p>Create your first snapshot to save a copy of the current database.</p>
                </div>
              )}
            </section>

            <section className="backup-restore" aria-labelledby="backup-restore-title">
              <ShieldCheck size={22} aria-hidden="true" />
              <div>
                <h2 id="backup-restore-title">Restoring a backup</h2>
                <p>
                  Keep the SQLite file and manifest together. On the private server, place them as{' '}
                  <code>database.sqlite</code> and <code>manifest.json</code> in the snapshot-ID folder.
                </p>
                <p>
                  Restore requires stopping the server and using the administrator restore utility. Do not
                  replace a running database. The utility checks the snapshot before restoring; start the
                  server again only after the restore completes.
                </p>
                <p>
                  A database restore also restores saved account and payment records to that point in time.
                  Keep a current backup and the corresponding uploaded files before restoring.
                </p>
              </div>
            </section>
          </>
        )
      )}
    </div>
  );
}
