import { useState } from 'react';
import { ArrowLeft, Search, LoaderCircle, Building2, CheckCircle2, Info, RefreshCw } from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import { STATES, type Customer, type GstLookupResult } from '../../../shared/types';
import {
  CONTACT_ROLE_LABELS,
  CONTACT_ROLES,
  normalizeContact,
  type ContactRole,
} from '../../../shared/contact-types';
import './contacts.css';
import '../../shared/styles/page-editors.css';

interface Props {
  organizationId: string;
  customer?: Customer;
  defaultRole?: ContactRole;
  invoiceRecipientOnly?: boolean;
  onClose: () => void;
  onSave: (input: Omit<Customer, 'id'>, id?: string) => Promise<void>;
}

export default function CustomerEditor({
  organizationId,
  customer,
  defaultRole = 'customer',
  invoiceRecipientOnly = false,
  onClose,
  onSave,
}: Props) {
  const [form, setForm] = useState<Omit<Customer, 'id'>>(() =>
    normalizeContact(
      customer || {
        organizationId,
        name: '',
        email: '',
        phone: '',
        gstin: '',
        address: '',
        stateCode: '',
        contactPerson: '',
        roles: [defaultRole],
      },
    ),
  );
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [lookupMessage, setLookupMessage] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [lookupDate, setLookupDate] = useState('');
  const [challenge, setChallenge] = useState<{ challengeId: string; image: string } | null>(null);
  const [captcha, setCaptcha] = useState('');
  const change = <K extends keyof Omit<Customer, 'id'>>(field: K, value: Omit<Customer, 'id'>[K]) =>
    setForm((current) => ({ ...current, [field]: value }));
  const roles = form.roles || ['customer'];
  const contactLabel = roles.length === 1 ? CONTACT_ROLE_LABELS[roles[0]].toLowerCase() : 'contact';
  function toggleRole(role: ContactRole) {
    const next = roles.includes(role) ? roles.filter((value) => value !== role) : [...roles, role];
    if (!next.length) {
      setError('Keep at least one role for this contact.');
      return;
    }
    change('roles', next);
    setError('');
  }
  function applyLookup(result: GstLookupResult) {
    setForm((current) => ({
      ...current,
      gstin: result.gstin,
      name: result.name,
      address: result.address,
      stateCode: result.stateCode,
    }));
    setLookupMessage(
      `Business details fetched${result.status ? ` · ${result.status}` : ''}. Please review before saving.`,
    );
    setLookupDate(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    setChallenge(null);
    setCaptcha('');
  }
  async function lookup() {
    setFetching(true);
    setLookupError('');
    setLookupMessage('');
    try {
      const health = await api<{ gstMode: 'portal' | 'provider' }>('/health');
      if (health.gstMode === 'portal') {
        const nextChallenge = await api<{ challengeId: string; image: string }>('/gst/captcha');
        setChallenge(nextChallenge);
        setCaptcha('');
      } else {
        applyLookup(
          await api<GstLookupResult>(`/gst/${encodeURIComponent(form.gstin.trim().toUpperCase())}`),
        );
      }
    } catch (err) {
      setLookupError((err as Error).message);
    } finally {
      setFetching(false);
    }
  }
  async function verifyCaptcha() {
    if (!challenge) return;
    setFetching(true);
    setLookupError('');
    setLookupMessage('');
    try {
      applyLookup(
        await api<GstLookupResult>(
          '/gst/lookup',
          sendJson('POST', {
            gstin: form.gstin.trim().toUpperCase(),
            challengeId: challenge.challengeId,
            captcha,
          }),
        ),
      );
    } catch (err) {
      setLookupError((err as Error).message);
      setChallenge(null);
      setCaptcha('');
    } finally {
      setFetching(false);
    }
  }
  return (
    <section className="workspace-page editor-page customer-page" aria-labelledby="customer-heading">
      <nav className="editor-page-navigation" aria-label="Contact page navigation">
        <button type="button" className="button secondary" disabled={saving} onClick={onClose}>
          <ArrowLeft size={16} />
          Back
        </button>
      </nav>
      <div className="editor-page-panel">
        <header className="editor-page-heading">
          <div className="editor-page-title-icon">
            <Building2 size={22} />
          </div>
          <div>
            <h1 id="customer-heading">{customer ? `Edit ${contactLabel}` : `Add ${contactLabel}`}</h1>
            <p>Contact details belong to this organization.</p>
          </div>
        </header>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            setSaving(true);
            setError('');
            try {
              await onSave(form, customer?.id);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <fieldset className="contact-fieldset" disabled={saving}>
            <div className="editor-page-body">
              <div className="contact-role-picker">
                <span className="contact-section-label">
                  This contact is a <span className="required">*</span>
                </span>
                <div role="group" aria-label="Contact roles">
                  {CONTACT_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      className={roles.includes(role) ? 'selected' : ''}
                      aria-pressed={roles.includes(role)}
                      onClick={() => toggleRole(role)}
                    >
                      {CONTACT_ROLE_LABELS[role]}
                      {roles.includes(role) && <CheckCircle2 size={14} />}
                    </button>
                  ))}
                </div>
                <p className="field-hint">
                  {invoiceRecipientOnly ? 'Save this contact and select it directly on your document. ' : ''}
                  Customers, B2B buyers and vendors can all be selected on this organization’s documents.
                  Select multiple roles for the same business.
                </p>
              </div>
              <div className="gst-box">
                <div className="label-row">
                  <label htmlFor="customer-gstin">
                    Start with a GSTIN <span className="optional">optional</span>
                  </label>
                  <span className="mini-label">AUTO-FILL</span>
                </div>
                <div className="input-action">
                  <input
                    id="customer-gstin"
                    placeholder="15-character GST registration number"
                    value={form.gstin}
                    maxLength={15}
                    disabled={fetching}
                    onChange={(e) => {
                      change('gstin', e.target.value.toUpperCase());
                      setLookupMessage('');
                      setLookupError('');
                      setChallenge(null);
                      setCaptcha('');
                    }}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    disabled={fetching || form.gstin.length !== 15}
                    onClick={lookup}
                  >
                    {fetching ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{' '}
                    {fetching ? 'Fetching…' : 'Fetch details'}
                  </button>
                </div>
                <p className="field-hint">
                  Free portal lookup asks you to enter a CAPTCHA. You can also fill in details below.
                </p>
                {challenge && (
                  <div className="captcha-panel">
                    <label htmlFor="gst-captcha">Enter the six digits shown by the GST portal</label>
                    <img src={challenge.image} alt="GST portal CAPTCHA — enter the displayed six digits" />
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="Refresh GST CAPTCHA"
                      disabled={fetching}
                      onClick={lookup}
                    >
                      <RefreshCw size={16} />
                    </button>
                    <input
                      id="gst-captcha"
                      aria-label="GST CAPTCHA"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="6 digits"
                      maxLength={6}
                      value={captcha}
                      disabled={fetching}
                      onChange={(e) => setCaptcha(e.target.value.replace(/\D/g, ''))}
                    />
                    <button
                      type="button"
                      className="button primary"
                      disabled={fetching || captcha.length !== 6}
                      onClick={verifyCaptcha}
                    >
                      Verify & fill
                    </button>
                    <p className="field-hint">
                      Your GSTIN is sent to the GST portal when you verify. CAPTCHA expires after 3 minutes.
                    </p>
                  </div>
                )}
                {lookupError && (
                  <div className="form-error" role="alert">
                    <Info size={16} />
                    {lookupError}
                  </div>
                )}
                {lookupMessage && (
                  <div className="form-success" role="status">
                    <CheckCircle2 size={16} />
                    {lookupMessage} <small>{lookupDate}</small>
                  </div>
                )}
              </div>
              <div className="form-grid">
                <label className="span-two">
                  Business / customer name <span className="required">*</span>
                  <input
                    required
                    autoFocus
                    maxLength={200}
                    value={form.name}
                    onChange={(e) => change('name', e.target.value)}
                    placeholder="Enter a person's name or registered business name"
                  />
                </label>
                <label>
                  Contact person
                  <input
                    maxLength={200}
                    value={form.contactPerson}
                    onChange={(e) => change('contactPerson', e.target.value)}
                    placeholder="Full name"
                  />
                </label>
                <label>
                  Email address
                  <input
                    type="email"
                    maxLength={254}
                    value={form.email}
                    onChange={(e) => change('email', e.target.value)}
                    placeholder="name@company.com"
                  />
                  <span className="field-hint">
                    Used for invoices and payment updates when email is enabled.
                  </span>
                </label>
                <label>
                  Phone number
                  <input
                    type="tel"
                    maxLength={30}
                    value={form.phone}
                    onChange={(e) => change('phone', e.target.value)}
                    placeholder="+91"
                  />
                </label>
                <label>
                  PAN <span className="optional">optional</span>
                  <input
                    maxLength={10}
                    value={form.pan || ''}
                    onChange={(e) => change('pan', e.target.value.toUpperCase())}
                    placeholder="ABCDE1234F"
                  />
                </label>
                <label>
                  State / union territory
                  <select value={form.stateCode} onChange={(e) => change('stateCode', e.target.value)}>
                    <option value="">Select a state</option>
                    {STATES.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-two">
                  Billing address
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={form.address}
                    onChange={(e) => change('address', e.target.value)}
                    placeholder="Street address, city and PIN code"
                  />
                </label>
              </div>
              <section className="contact-form-section">
                <div className="contact-section-heading">
                  <h3>Shipping details</h3>
                  <button
                    type="button"
                    className="text-button green"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        shippingAddress: current.address,
                        shippingStateCode: current.stateCode,
                      }))
                    }
                  >
                    Copy billing address
                  </button>
                </div>
                <div className="form-grid">
                  <label className="span-two">
                    Shipping address
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={form.shippingAddress || ''}
                      onChange={(e) => change('shippingAddress', e.target.value)}
                      placeholder="Delivery location, city and PIN code"
                    />
                  </label>
                  <label>
                    Shipping state
                    <select
                      value={form.shippingStateCode || ''}
                      onChange={(e) => change('shippingStateCode', e.target.value)}
                    >
                      <option value="">Select a state</option>
                      {STATES.map(([code, name]) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
              <section className="contact-form-section">
                <div className="contact-section-heading">
                  <h3>Business preferences</h3>
                  <span className="optional">optional</span>
                </div>
                <div className="form-grid">
                  <label>
                    Payment terms (days)
                    <input
                      type="number"
                      min="0"
                      max="365"
                      step="1"
                      value={form.paymentTermsDays || ''}
                      onChange={(e) => change('paymentTermsDays', Number(e.target.value))}
                      placeholder="e.g. 30"
                    />
                    <span className="field-hint">
                      Suggested due date for new sales invoices; 0 leaves the default.
                    </span>
                  </label>
                  <label>
                    Credit limit (₹)
                    <input
                      type="number"
                      min="0"
                      max="1000000000"
                      step="0.01"
                      value={form.creditLimit || ''}
                      onChange={(e) => change('creditLimit', Number(e.target.value))}
                      placeholder="Not set"
                    />
                    <span className="field-hint">
                      For your team's reference. Does not block billing or calculate credit.
                    </span>
                  </label>
                  <label className="span-two">
                    Internal notes
                    <textarea
                      rows={3}
                      maxLength={4000}
                      value={form.notes || ''}
                      onChange={(e) => change('notes', e.target.value)}
                      placeholder="Purchase contact, delivery instructions, or details for your team"
                    />
                    <span className="field-hint">Notes and credit limits are not printed on invoices.</span>
                  </label>
                </div>
              </section>
              {customer && (
                <p className="field-hint">
                  <Info size={14} /> Existing invoices keep the contact details recorded when they were
                  created.
                </p>
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          </fieldset>
          <footer className="editor-page-footer">
            <span>
              <span className="required">*</span> Required field
            </span>
            <button type="button" className="button secondary" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={saving || fetching}>
              {saving && <LoaderCircle size={16} className="spin" />}
              {saving ? 'Saving…' : customer ? 'Save changes' : `Save ${contactLabel}`}
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
