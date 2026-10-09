import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  Building2,
  CheckCircle2,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Store,
  UsersRound,
} from 'lucide-react';
import type { Customer } from '../../../shared/types';
import { money } from '../../../shared/types';
import { CONTACT_ROLE_LABELS, contactRoles, type ContactRole } from '../../../shared/contact-types';
import CustomerEditor from './CustomerEditor';
import type { ManagerNavigation, ManagerPage } from '../../app/manager-page';
import './contacts.css';

interface Props extends ManagerNavigation {
  organizationId: string;
  organizationName?: string;
  contacts: Customer[];
  onSave: (input: Omit<Customer, 'id'>, id?: string) => Promise<void>;
}

type Filter = 'all' | ContactRole | 'archived';
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

export default function ContactsManager({
  organizationId,
  organizationName = 'this organization',
  contacts,
  onSave,
  page: requestedPage,
  onNavigate,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [localPage, setLocalPage] = useState<ManagerPage | null>(null);
  const childPage = requestedPage === undefined ? localPage : requestedPage;
  const navigate = (next: ManagerPage | null) => {
    setError('');
    if (onNavigate) onNavigate(next);
    else setLocalPage(next);
  };
  useEffect(() => {
    setFilter('all');
    setSearch('');
    setLocalPage(null);
    setError('');
    setMessage('');
    setPage(0);
  }, [organizationId]);
  useEffect(() => setPage(0), [filter, search]);
  const scoped = useMemo(
    () => contacts.filter((contact) => contact.organizationId === organizationId),
    [contacts, organizationId],
  );
  const active = scoped.filter((contact) => contact.active !== false);
  const count = (role: ContactRole) =>
    active.filter((contact) => contactRoles(contact).includes(role)).length;
  const counts = { customer: count('customer'), vendor: count('vendor'), b2b_buyer: count('b2b_buyer') };
  const filtered = scoped
    .filter((contact) => {
      const matchesFilter =
        filter === 'archived'
          ? contact.active === false
          : contact.active !== false && (filter === 'all' || contactRoles(contact).includes(filter));
      return (
        matchesFilter &&
        [
          contact.name,
          contact.email,
          contact.phone,
          contact.gstin,
          contact.pan,
          contact.contactPerson,
          contact.address,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 15) - 1));
  const visible = filtered.slice(currentPage * 15, (currentPage + 1) * 15);
  const suggestedRole: ContactRole = filter === 'vendor' || filter === 'b2b_buyer' ? filter : 'customer';

  async function toggleArchive(contact: Customer) {
    if (busy) return;
    const restoring = contact.active === false;
    setBusy(contact.id);
    setError('');
    setMessage('');
    try {
      await onSave({ ...contact, active: restoring }, contact.id);
      setMessage(
        `${contact.name} ${restoring ? 'restored' : 'archived'}. Existing documents keep their saved details.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  function exportContacts() {
    const rows = [
      [
        'Name',
        'Roles',
        'Contact person',
        'Email',
        'Phone',
        'GSTIN',
        'PAN',
        'Billing address',
        'Billing state',
        'Shipping address',
        'Shipping state',
        'Payment terms (days)',
        'Credit limit (INR)',
        'Status',
      ],
      ...filtered.map((contact) => [
        contact.name,
        contactRoles(contact)
          .map((role) => CONTACT_ROLE_LABELS[role])
          .join(', '),
        contact.contactPerson,
        contact.email,
        contact.phone,
        contact.gstin,
        contact.pan || '',
        contact.address,
        contact.stateCode,
        contact.shippingAddress || '',
        contact.shippingStateCode || '',
        contact.paymentTermsDays || '',
        contact.creditLimit || '',
        contact.active === false ? 'Archived' : 'Active',
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value);
            if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
            return `"${text.replaceAll('"', '""')}"`;
          })
          .join(','),
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${organizationName.replace(/[^a-z0-9]+/gi, '-')}-contacts.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (childPage) {
    const contact = childPage.id ? scoped.find((value) => value.id === childPage.id) : undefined;
    if (
      childPage.action === 'delete' ||
      (childPage.action === 'edit' && !contact) ||
      (childPage.id && !contact)
    )
      return (
        <section className="panel contacts-page-message">
          <h2>
            {childPage.action === 'delete'
              ? 'Use the contact directory to archive this record'
              : 'Contact not found'}
          </h2>
          <p>This contact may no longer be available in {organizationName}.</p>
          <button className="button secondary" onClick={() => navigate(null)}>
            <ArrowLeft size={16} />
            Back to contacts
          </button>
        </section>
      );
    return (
      <CustomerEditor
        key={`${childPage.action}-${childPage.id || childPage.role || 'customer'}`}
        organizationId={organizationId}
        customer={childPage.action === 'edit' ? contact : undefined}
        defaultRole={childPage.role}
        onClose={() => navigate(null)}
        onSave={async (input, id) => {
          await onSave(input, id);
          navigate(null);
          setMessage(`${input.name} saved.`);
        }}
      />
    );
  }
  return (
    <div className="contacts-workspace">
      <section className="contacts-intro">
        <div>
          <span className="contacts-kicker">
            <UsersRound size={14} /> YOUR BUSINESS DIRECTORY
          </span>
          <h2>
            Every business relationship,
            <br />
            in one place.
          </h2>
          <p>Customers, vendors and business buyers for {organizationName}.</p>
          <div className="contacts-add-actions">
            <button className="button primary" onClick={() => navigate({ action: 'new', role: 'customer' })}>
              <Plus size={15} />
              Add customer
            </button>
            <button className="button secondary" onClick={() => navigate({ action: 'new', role: 'vendor' })}>
              <Plus size={15} />
              Add vendor
            </button>
            <button
              className="button secondary"
              onClick={() => navigate({ action: 'new', role: 'b2b_buyer' })}
            >
              <Plus size={15} />
              Add B2B buyer
            </button>
          </div>
        </div>
        <div className="contacts-counts">
          {(
            [
              ['customer', UsersRound],
              ['vendor', Store],
              ['b2b_buyer', Building2],
            ] as const
          ).map(([role, Icon]) => (
            <button
              key={role}
              className={`contacts-count ${role}`}
              onClick={() => {
                setFilter(role);
                setSearch('');
              }}
              aria-label={`Show ${CONTACT_ROLE_LABELS[role].toLowerCase()} contacts`}
            >
              <Icon size={20} />
              <strong>{counts[role]}</strong>
              <span>{role === 'b2b_buyer' ? 'B2B buyers' : `${CONTACT_ROLE_LABELS[role]}s`}</span>
            </button>
          ))}
        </div>
      </section>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="form-success" role="status">
          <CheckCircle2 size={16} />
          {message}
        </div>
      )}
      <section className="panel contacts-panel">
        <div className="contacts-toolbar">
          <div className="filter-tabs" aria-label="Contact filters">
            {(
              [
                ['all', 'All active', active.length],
                ['customer', 'Customers', counts.customer],
                ['vendor', 'Vendors', counts.vendor],
                ['b2b_buyer', 'B2B buyers', counts.b2b_buyer],
                ['archived', 'Archived', scoped.length - active.length],
              ] as const
            ).map(([key, label, total]) => (
              <button
                key={key}
                className={filter === key ? 'selected' : ''}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span>{total}</span>
              </button>
            ))}
          </div>
          <div className="contacts-toolbar-actions">
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search contacts"
                placeholder="Name, email, GSTIN or phone…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <button className="button secondary" onClick={exportContacts} disabled={!filtered.length}>
              <ArrowDownToLine size={15} />
              Export
            </button>
          </div>
        </div>
        {visible.length ? (
          <div className="table-scroll">
            <table className="data-table contacts-table">
              <thead>
                <tr>
                  <th>NAME / ROLE</th>
                  <th>CONTACT DETAILS</th>
                  <th>TAX DETAILS</th>
                  <th>TERMS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <div className="document-cell">
                        <span className="customer-avatar">{initials(contact.name)}</span>
                        <div>
                          <button
                            className="text-button contact-name"
                            onClick={() => navigate({ action: 'edit', id: contact.id })}
                          >
                            {contact.name}
                          </button>
                          <span>{contact.contactPerson || 'No contact person'}</span>
                          <div className="contact-role-badges">
                            {contactRoles(contact).map((role) => (
                              <span key={role} className={`contact-role-badge ${role}`}>
                                {CONTACT_ROLE_LABELS[role]}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="contact-email">{contact.email || 'No email added'}</span>
                      <small>{contact.phone || 'No phone added'}</small>
                    </td>
                    <td>
                      <span className="mono">{contact.gstin || 'GSTIN not added'}</span>
                      <small>{contact.pan ? `PAN: ${contact.pan}` : 'PAN not added'}</small>
                    </td>
                    <td>
                      {contact.paymentTermsDays ? `Net ${contact.paymentTermsDays} days` : 'Standard terms'}
                      <small>
                        {contact.creditLimit
                          ? `Credit reference: ${money(contact.creditLimit)}`
                          : 'No credit limit set'}
                      </small>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          disabled={!!busy}
                          aria-label={`Edit ${contact.name}`}
                          onClick={() => navigate({ action: 'edit', id: contact.id })}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={!!busy}
                          aria-label={`${contact.active === false ? 'Restore' : 'Archive'} ${contact.name}`}
                          onClick={() => toggleArchive(contact)}
                        >
                          {busy === contact.id ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : contact.active === false ? (
                            <RotateCcw size={15} />
                          ) : (
                            <Archive size={15} />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state contacts-empty">
            <div className="empty-document">
              <UsersRound size={30} />
            </div>
            <h3>
              {search
                ? 'No matching contacts'
                : filter === 'archived'
                  ? 'No archived contacts'
                  : `Add your first ${filter === 'all' ? 'business contact' : CONTACT_ROLE_LABELS[filter].toLowerCase()}`}
            </h3>
            <p>
              {search
                ? 'Try a name, contact person, email, phone or GSTIN.'
                : filter === 'archived'
                  ? 'Archived contacts remain saved and can be restored here.'
                  : 'Save billing and shipping details, GST information and payment preferences once.'}
            </p>
            {!search && filter !== 'archived' && (
              <button
                className="button primary"
                onClick={() => navigate({ action: 'new', role: suggestedRole })}
              >
                <Plus size={15} />
                Add {CONTACT_ROLE_LABELS[suggestedRole].toLowerCase()}
              </button>
            )}
          </div>
        )}
        <div className="contacts-footer">
          <span>
            {filtered.length} {filter === 'archived' ? 'archived' : 'active'} contacts
          </span>
          {filtered.length > 15 && (
            <div>
              <button
                className="text-button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(filtered.length / 15)}
              </span>
              <button
                className="text-button"
                disabled={(currentPage + 1) * 15 >= filtered.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          )}
          <span>
            <ShieldCheck size={14} /> Saved within this organization
          </span>
        </div>
      </section>
      <p className="contacts-explainer">
        Save customers, B2B buyers and vendors here, then search and select any active contact when creating
        an invoice, quotation or delivery challan for this organization. Their saved billing, GST and shipping
        details fill the document automatically. Archiving keeps earlier documents intact.
      </p>
    </div>
  );
}
