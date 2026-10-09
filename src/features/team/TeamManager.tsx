import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Search, ShieldCheck, UsersRound } from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import type { AuthUser, UserAccessInput } from '../../../shared/auth-types';
import type { Organization } from '../../../shared/types';
import '../auth/auth.css';

type Props = {
  organizations: Organization[];
  currentUser: AuthUser;
  onCurrentUserChange?: (user: AuthUser) => void;
};
const displayDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(value))
    : 'Not yet';
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase();

function UserCard({
  user,
  organizations,
  currentUser,
  onSaved,
}: {
  user: AuthUser;
  organizations: Organization[];
  currentUser: AuthUser;
  onSaved: (user: AuthUser) => void;
}) {
  const [draft, setDraft] = useState<UserAccessInput>({
    role: user.role,
    status: user.status,
    organizationIds: user.organizationIds,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft({ role: user.role, status: user.status, organizationIds: user.organizationIds });
  }, [user]);
  const changed =
    draft.role !== user.role ||
    draft.status !== user.status ||
    [...draft.organizationIds].sort().join(',') !== [...user.organizationIds].sort().join(',');
  const approving = user.status === 'pending' && draft.status === 'active';
  const organizationRequired =
    draft.role === 'staff' && draft.status === 'active' && !draft.organizationIds.length;
  const isSelf = user.id === currentUser.id;
  function toggleOrganization(id: string) {
    setDraft((current) => ({
      ...current,
      organizationIds: current.organizationIds.includes(id)
        ? current.organizationIds.filter((value) => value !== id)
        : [...current.organizationIds, id],
    }));
  }
  async function save() {
    if (saving || !changed || organizationRequired) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api<AuthUser>(
        `/auth/users/${encodeURIComponent(user.id)}`,
        sendJson('PATCH', { ...draft, organizationIds: draft.role === 'admin' ? [] : draft.organizationIds }),
      );
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update account access.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className="team-user-card" aria-labelledby={`team-user-${user.id}`}>
      <div className="team-user-heading">
        <span className="team-user-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <div className="team-user-identity">
          <h3 id={`team-user-${user.id}`}>
            {user.name}
            {isSelf && <span>You</span>}
          </h3>
          <p>{user.email}</p>
        </div>
        <span className={`team-access-status ${user.status}`}>
          {user.status === 'pending' ? 'Awaiting approval' : user.status === 'active' ? 'Active' : 'Disabled'}
        </span>
      </div>
      <div className="team-user-meta">
        {user.company && <span>Company / team: {user.company}</span>}
        <span>Requested {displayDate(user.createdAt)}</span>
        <span>Last login: {displayDate(user.lastLoginAt)}</span>
      </div>
      <div className="team-access-fields">
        <label>
          Account status
          <select
            value={draft.status}
            onChange={(e) =>
              setDraft((current) => ({ ...current, status: e.target.value as AuthUser['status'] }))
            }
            disabled={saving}
            aria-label={`Account status for ${user.email}`}
          >
            <option value="pending">Pending approval</option>
            <option value="active">Active — approved</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label>
          Workspace role
          <select
            value={draft.role}
            onChange={(e) =>
              setDraft((current) => ({ ...current, role: e.target.value as AuthUser['role'] }))
            }
            disabled={saving}
            aria-label={`Workspace role for ${user.email}`}
          >
            <option value="staff">Staff — assigned organizations</option>
            <option value="admin">Administrator — full workspace</option>
          </select>
        </label>
      </div>
      {draft.role === 'admin' ? (
        <p className="team-admin-note">
          <ShieldCheck size={16} />
          <span>
            Administrators can access every organization, manage team approvals and configure the workspace.
            Assign this role only when full access is needed.
          </span>
        </p>
      ) : (
        <fieldset disabled={saving}>
          <legend>Organizations this person can access</legend>
          {organizations.length ? (
            <div className="team-org-options">
              {organizations.map((organization) => (
                <label key={organization.id}>
                  <input
                    type="checkbox"
                    checked={draft.organizationIds.includes(organization.id)}
                    onChange={() => toggleOrganization(organization.id)}
                  />
                  <span>{organization.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="team-admin-note">Create an organization before activating a staff account.</p>
          )}
        </fieldset>
      )}
      {error && (
        <div className="inv-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="team-user-actions">
        <span>
          {organizationRequired
            ? 'Select at least one organization to activate this staff account.'
            : isSelf && changed
              ? 'Updating your own access will end your session. Log in again after saving.'
              : draft.status === 'disabled'
                ? 'Disabled accounts cannot log in. Existing sessions end when this is saved.'
                : draft.status === 'pending'
                  ? 'Pending accounts cannot open the workspace until approved.'
                  : 'Saved access changes end this person’s existing sessions.'}
        </span>
        <button
          type="button"
          className="button primary"
          onClick={() => void save()}
          disabled={saving || !changed || organizationRequired}
        >
          {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {saving ? 'Saving…' : approving ? 'Approve account' : 'Save access'}
        </button>
      </div>
    </article>
  );
}

export default function TeamManager({ organizations, currentUser, onCurrentUserChange }: Props) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(await api<AuthUser[]>('/auth/users'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workspace members.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  function saved(next: AuthUser) {
    setUsers((current) => current.map((user) => (user.id === next.id ? next : user)));
    setNotice(`${next.name}’s access has been saved.`);
    if (next.id === currentUser.id) {
      onCurrentUserChange?.(next);
      window.dispatchEvent(new Event('vc-session-expired'));
    }
  }
  const query = search.trim().toLowerCase();
  const visible = users
    .filter(
      (user) =>
        (status === 'all' || user.status === status) &&
        `${user.name} ${user.email} ${user.company}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        Number(b.status === 'pending') - Number(a.status === 'pending') ||
        b.createdAt.localeCompare(a.createdAt),
    );
  return (
    <div className="team-manager">
      <div className="team-intro">
        <ShieldCheck size={24} />
        <div>
          <h2>The right access for every person.</h2>
          <p>
            New signups wait here for administrator approval. Give staff access to the organizations they work
            with, or assign an administrator to manage the whole workspace. Organization access applies to
            customers, vendors, buyers, catalog items and documents.
          </p>
        </div>
      </div>
      <div className="team-summary">
        <div>
          <strong>{users.filter((user) => user.status === 'pending').length}</strong>Awaiting approval
        </div>
        <div>
          <strong>{users.filter((user) => user.status === 'active').length}</strong>Active members
        </div>
        <div>
          <strong>{users.filter((user) => user.status === 'disabled').length}</strong>Disabled accounts
        </div>
      </div>
      {notice && (
        <div className="inv-form-notice" role="status">
          <Check size={17} />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="inv-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="team-toolbar">
        <label className="team-search">
          <span className="team-screenreader">Search team members</span>
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or company"
            type="search"
          />
        </label>
        <label>
          <span className="team-screenreader">Filter account status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter account status"
          >
            <option value="all">All accounts</option>
            <option value="pending">Awaiting approval</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <button type="button" className="team-refresh" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>
      {loading ? (
        <div className="team-empty" role="status">
          <LoaderCircle size={23} className="spin" />
          <p>Loading workspace members…</p>
        </div>
      ) : visible.length ? (
        <div className="team-users">
          {visible.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              organizations={organizations}
              currentUser={currentUser}
              onSaved={saved}
            />
          ))}
        </div>
      ) : (
        <div className="team-empty">
          <UsersRound size={28} />
          <h3>
            {search || status !== 'all'
              ? 'No matching accounts'
              : error
                ? 'Team accounts could not be loaded'
                : 'No account requests yet'}
          </h3>
          <p>
            {search || status !== 'all'
              ? 'Try another name, email or status filter.'
              : error
                ? 'Use Refresh to try again.'
                : 'People can request access using Sign up on your Venturecore INV home page.'}
          </p>
        </div>
      )}
    </div>
  );
}
