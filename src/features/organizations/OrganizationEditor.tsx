import { useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  ImagePlus,
  LoaderCircle,
  Palette,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { COMPANY_NAME, STATES } from '../../../shared/types';
import type { Organization } from '../../../shared/types';
import './organization.css';
import '../../shared/styles/page-editors.css';
import BrandImageUpload from '../../shared/ui/BrandImageUpload';
import { BILLING_PROFILES, billingProfileFor } from '../../../shared/billing-presets';
import type { BillingProfile } from '../../../shared/types';

interface OrganizationEditorProps {
  organization?: Organization;
  companyDefaults?: Organization;
  onSave: (input: Omit<Organization, 'id'>, id?: string) => Promise<void>;
  onClose: () => void;
}

type Tab = 'details' | 'design' | 'payment';
const COLORS = ['#26705b', '#2c526b', '#6e52a3', '#b96739', '#a44969', '#263744'];
const TABS = [
  { id: 'details', label: 'Details', icon: Building2 },
  { id: 'design', label: 'Logo & invoice design', icon: Palette },
  { id: 'payment', label: 'Payment details', icon: CreditCard },
] as const;
const INITIAL: Omit<Organization, 'id'> = {
  name: '',
  legalName: '',
  tradeName: '',
  businessConstitution: '',
  businessType: 'division',
  supportEmail: 'support@pirento.com',
  paymentGateway: 'razorpay',
  gstRegistrations: [],
  gstin: '',
  email: '',
  phone: '',
  address: '',
  stateCode: '',
  accentColor: '#26705b',
  logoUrl: '',
  invoicePrefix: 'INV',
  quotationPrefix: 'QUO',
  billingProfile: 'general',
  enableProductSelection: false,
  secondarySignatureLabel: '',
  secondarySignatureImageUrl: '',
  stampLabel: '',
  stampImageUrl: '',
  pan: '',
  cin: '',
  bankBranch: '',
  accountType: '',
  signatureImageUrl: '',
  paymentQrUrl: '',
  bankName: '',
  accountName: '',
  accountNumber: '',
  ifsc: '',
  terms: '',
  signature: '',
  template: 'modern',
};

function usableLogo(value: string) {
  if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export default function OrganizationEditor({
  organization,
  companyDefaults,
  onSave,
  onClose,
}: OrganizationEditorProps) {
  const [form, setForm] = useState<Omit<Organization, 'id'>>(() => {
    if (!organization) return { ...INITIAL, gstRegistrations: [] };
    const { id: _id, ...settings } = organization;
    return { ...INITIAL, ...settings, billingProfile: billingProfileFor(organization) };
  });
  const [tab, setTab] = useState<Tab>('details');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploadName, setUploadName] = useState(
    organization?.logoUrl.startsWith('data:') ? 'Uploaded brand logo' : '',
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof Omit<Organization, 'id'>>(key: K, value: Omit<Organization, 'id'>[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const initials =
    form.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase() || 'VC';
  const safeAccent = /^#[0-9a-f]{6}$/i.test(form.accentColor) ? form.accentColor : INITIAL.accentColor;
  const logoReady = usableLogo(form.logoUrl);
  const registrations = form.gstRegistrations || [];
  const availableCompanyDefaults =
    companyDefaults?.businessType !== 'independent' &&
    companyDefaults?.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase()
      ? companyDefaults
      : undefined;

  function changeBusinessType(businessType: 'division' | 'independent') {
    setForm((current) => {
      if (organization || businessType === 'division') return { ...current, businessType };
      // A new independent business must never retain identity or payment details copied from a division.
      return {
        ...current,
        businessType,
        legalName: '',
        tradeName: '',
        businessConstitution: '',
        gstin: '',
        gstRegistrations: [],
        stateCode: '',
        address: '',
        pan: '',
        cin: '',
        email: '',
        phone: '',
        supportEmail: '',
        bankName: '',
        accountName: '',
        accountNumber: '',
        ifsc: '',
        bankBranch: '',
        accountType: '',
        paymentQrUrl: '',
        signature: '',
        signatureImageUrl: '',
        secondarySignatureLabel: '',
        secondarySignatureImageUrl: '',
        stampLabel: '',
        stampImageUrl: '',
        terms: '',
        paymentGateway: 'none',
      };
    });
  }

  function useCompanyDetails() {
    if (!availableCompanyDefaults || form.businessType === 'independent') return;
    const identityKeys = [
      'legalName',
      'tradeName',
      'businessConstitution',
      'gstin',
      'email',
      'phone',
      'address',
      'stateCode',
      'signatureImageUrl',
      'paymentQrUrl',
      'pan',
      'cin',
      'bankName',
      'accountName',
      'accountNumber',
      'ifsc',
      'bankBranch',
      'accountType',
      'terms',
      'signature',
      'supportEmail',
      'paymentGateway',
    ] as const;
    const defaults: Partial<Organization> = Object.fromEntries(
      identityKeys.map((key) => [key, availableCompanyDefaults[key]]),
    );
    defaults.gstRegistrations = (availableCompanyDefaults.gstRegistrations || []).map((registration) => ({
      ...registration,
      id: crypto.randomUUID(),
    }));
    setForm((current) => ({ ...current, ...defaults }));
  }

  function updateRegistration(
    id: string,
    patch: Partial<NonNullable<Organization['gstRegistrations']>[number]>,
  ) {
    setForm((current) => ({
      ...current,
      gstRegistrations: (current.gstRegistrations || []).map((registration) =>
        registration.id === id ? { ...registration, ...patch } : registration,
      ),
    }));
  }

  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPG or WebP image for your logo.');
      return;
    }
    if (file.size > 500 * 1024) {
      setError('Your logo must be smaller than 500 KB.');
      return;
    }
    setError('');
    setUploading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('This image could not be read. Please try another file.'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error('This file could not be opened as an image. Please choose another logo.'));
        image.src = data;
      });
      update('logoUrl', data);
      setUploadName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload the logo.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || uploading) return;
    const input = {
      ...form,
      name: form.name.trim(),
      legalName: form.legalName.trim(),
      tradeName: (form.tradeName || '').trim(),
      businessConstitution: (form.businessConstitution || '').trim(),
      supportEmail: (form.supportEmail || '').trim(),
      gstin: form.gstin.trim().toUpperCase(),
      email: form.email.trim(),
      gstRegistrations: registrations.map((registration) => ({
        ...registration,
        label: registration.label.trim(),
        gstin: registration.gstin.trim().toUpperCase(),
        address: registration.address.trim(),
      })),
      invoicePrefix: form.invoicePrefix.trim().toUpperCase(),
      quotationPrefix: form.quotationPrefix.trim().toUpperCase(),
      ifsc: form.ifsc.trim().toUpperCase(),
      logoUrl: form.logoUrl.trim(),
    };
    const fail = (message: string, target: Tab) => {
      setError(message);
      setTab(target);
    };
    if (!input.name) {
      fail('Add a name for this organization.', 'details');
      return;
    }
    if (!input.legalName) {
      fail('Enter the legal business name registered for this organization.', 'details');
      return;
    }
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      fail('Enter a valid business email address.', 'details');
      return;
    }
    if (input.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.supportEmail)) {
      fail('Enter a valid support email address.', 'details');
      return;
    }
    if (input.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(input.gstin)) {
      fail('Enter a valid 15-character GSTIN, or leave it blank until it is available.', 'details');
      return;
    }
    if (input.gstin && (!input.stateCode || input.gstin.slice(0, 2) !== input.stateCode)) {
      fail('Choose the state that matches the first two digits of the GSTIN.', 'details');
      return;
    }
    const usedGSTINs = new Set(input.gstin ? [input.gstin] : []);
    for (const registration of input.gstRegistrations) {
      if (
        !registration.label ||
        !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(registration.gstin)
      ) {
        fail('Give every additional GST registration a label and a valid 15-character GSTIN.', 'details');
        return;
      }
      if (!registration.stateCode || registration.gstin.slice(0, 2) !== registration.stateCode) {
        fail(`Choose the registered state for ${registration.label} to match its GSTIN.`, 'details');
        return;
      }
      if (usedGSTINs.has(registration.gstin)) {
        fail('Each GST registration must use a different GSTIN.', 'details');
        return;
      }
      usedGSTINs.add(registration.gstin);
    }
    if (![input.invoicePrefix, input.quotationPrefix].every((prefix) => /^[A-Z0-9]{1,4}$/.test(prefix))) {
      fail('Document prefixes need 1–4 letters or numbers.', 'design');
      return;
    }
    if (input.invoicePrefix === input.quotationPrefix) {
      fail('Use different prefixes for invoices and quotations.', 'design');
      return;
    }
    if (input.logoUrl && !usableLogo(input.logoUrl)) {
      fail('Use an HTTPS image URL or upload a PNG, JPG or WebP logo.', 'design');
      return;
    }
    if (input.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.ifsc)) {
      fail('Enter a valid 11-character IFSC code.', 'payment');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave(input, organization?.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to save this organization. Please try again.';
      setError(message);
      if (/prefix/i.test(message)) setTab('design');
      else if (/gst|registration|legal|pan|support|email/i.test(message)) setTab('details');
      else if (/bank|ifsc|gateway/i.test(message)) setTab('payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workspace-page organization-page" aria-labelledby="org-title">
      <nav className="editor-page-navigation" aria-label="Organization page navigation">
        <button className="button secondary" type="button" onClick={onClose} disabled={saving || uploading}>
          <ArrowLeft size={16} />
          Back
        </button>
      </nav>
      <div className="org-settings-panel" style={{ '--org-accent': safeAccent } as CSSProperties}>
        <header className="org-header">
          <div className="org-header-symbol">
            <Building2 size={21} />
          </div>
          <div>
            <p className="org-eyebrow">YOUR BUSINESS, CONNECTED</p>
            <h1 id="org-title">{organization ? 'Organization settings' : 'Create an organization'}</h1>
            <p>Set this business’s identity, GST and payment details.</p>
          </div>
        </header>
        <div className="org-tabs" role="tablist" aria-label="Organization settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`org-panel-${id}`}
              id={`org-tab-${id}`}
              className={tab === id ? 'org-tab org-tab-active' : 'org-tab'}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} noValidate className="org-form">
          <div className="org-body">
            <div
              className="org-fields"
              role="tabpanel"
              id={`org-panel-${tab}`}
              aria-labelledby={`org-tab-${tab}`}
            >
              {tab === 'details' && (
                <>
                  <div className="org-section-heading">
                    <h3>The essentials</h3>
                    <p>This name appears in the dashboard and on your quotations and invoices.</p>
                  </div>
                  <label className="org-field">
                    Organization name <span className="org-required">*</span>
                    <input
                      autoFocus
                      value={form.name}
                      onChange={(event) => update('name', event.target.value)}
                      placeholder="e.g. Pirento ecosystem"
                      required
                      maxLength={120}
                      autoComplete="organization"
                    />
                    <span className="org-helper">
                      Shown as the main dashboard brand whenever this organization is selected.
                    </span>
                  </label>
                  <div className="org-company-defaults">
                    <p>Give this organization its own dashboard and document logo.</p>
                    <button type="button" className="org-small-button" onClick={() => setTab('design')}>
                      <ImagePlus size={14} />
                      {form.logoUrl ? 'Edit organization logo' : 'Upload organization logo'}
                    </button>
                  </div>
                  <label className="org-field">
                    Business relationship
                    <select
                      disabled={organization?.id === 'shri-sarraf'}
                      value={form.businessType || 'division'}
                      onChange={(event) =>
                        changeBusinessType(event.target.value as 'division' | 'independent')
                      }
                    >
                      <option value="division">Venturecore division</option>
                      <option value="independent">Independent business</option>
                    </select>
                    <span className="org-helper">
                      An independent business uses its own legal identity, GST, bank account and payment
                      gateway.
                    </span>
                  </label>
                  {form.businessType !== 'independent' && availableCompanyDefaults && (
                    <div className="org-company-defaults">
                      <p>
                        Fill in Venturecore’s legal, contact and payment details. You can review them before
                        saving.
                      </p>
                      <button type="button" className="org-small-button" onClick={useCompanyDetails}>
                        <Building2 size={14} />
                        Use Venturecore company details
                      </button>
                    </div>
                  )}
                  <label className="org-field org-legal-field">
                    Legal business name <span className="org-required">*</span>
                    <input
                      value={form.legalName}
                      onChange={(event) => update('legalName', event.target.value)}
                      required
                      maxLength={200}
                      placeholder="Name on the GST / business registration"
                    />
                    <span className="org-helper">
                      This is the seller’s legal name on invoices and quotations.
                    </span>
                  </label>
                  <div className="org-grid">
                    <label className="org-field">
                      Trade name
                      <input
                        value={form.tradeName || ''}
                        onChange={(event) => update('tradeName', event.target.value)}
                        maxLength={200}
                        placeholder="Business / shop name"
                      />
                    </label>
                    <label className="org-field">
                      Business constitution
                      <input
                        value={form.businessConstitution || ''}
                        onChange={(event) => update('businessConstitution', event.target.value)}
                        maxLength={120}
                        placeholder="e.g. Private limited / Proprietorship"
                      />
                    </label>
                  </div>
                  <div className="org-divider" />
                  <div className="org-section-heading">
                    <h3>Default GST registration</h3>
                    <p>
                      New documents start with these details. Save additional registrations below to choose
                      another one while drafting.
                    </p>
                  </div>
                  <div className="org-grid">
                    <label className="org-field">
                      GSTIN <span className="org-optional">Optional</span>
                      <input
                        value={form.gstin}
                        onChange={(event) => {
                          const gstin = event.target.value.toUpperCase();
                          setForm((current) => ({
                            ...current,
                            gstin,
                            stateCode:
                              gstin.length >= 2 && STATES.some(([code]) => code === gstin.slice(0, 2))
                                ? gstin.slice(0, 2)
                                : current.stateCode,
                          }));
                        }}
                        placeholder="15-character GST number"
                        maxLength={15}
                        autoCapitalize="characters"
                      />
                    </label>
                    <label className="org-field">
                      Registered state
                      <div className="org-select-wrap">
                        <select
                          value={form.stateCode}
                          onChange={(event) => update('stateCode', event.target.value)}
                        >
                          <option value="">Select a state</option>
                          {STATES.map(([code, name]) => (
                            <option key={code} value={code}>
                              {name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </label>
                  </div>
                  <div className="org-grid">
                    <label className="org-field">
                      Business PAN
                      <input
                        value={form.pan || ''}
                        onChange={(event) => update('pan', event.target.value.toUpperCase())}
                        maxLength={10}
                        placeholder="Registered business PAN"
                      />
                    </label>
                    <label className="org-field">
                      CIN <span className="org-optional">If applicable</span>
                      <input
                        value={form.cin || ''}
                        onChange={(event) => update('cin', event.target.value.toUpperCase())}
                        maxLength={21}
                        placeholder="Corporate identity number"
                      />
                    </label>
                  </div>
                  <label className="org-field">
                    Business address
                    <textarea
                      rows={3}
                      value={form.address}
                      onChange={(event) => update('address', event.target.value)}
                      placeholder="Street address, city and PIN code"
                      maxLength={1500}
                      autoComplete="street-address"
                    />
                  </label>
                  <section className="org-registrations" aria-label="Additional GST registrations">
                    <div className="org-section-heading">
                      <h3>Additional GST registrations</h3>
                      <p>
                        Only add registrations belonging to this legal business. Existing documents keep their
                        saved seller details.
                      </p>
                    </div>
                    {registrations.map((registration, index) => (
                      <fieldset key={registration.id} className="org-registration">
                        <legend>Registration {index + 1}</legend>
                        <button
                          type="button"
                          className="org-registration-remove"
                          aria-label={`Remove GST registration ${registration.label || index + 1}`}
                          onClick={() =>
                            update(
                              'gstRegistrations',
                              registrations.filter((entry) => entry.id !== registration.id),
                            )
                          }
                        >
                          <Trash2 size={14} />
                          Remove
                        </button>
                        <label className="org-field">
                          Registration label
                          <input
                            value={registration.label}
                            onChange={(event) =>
                              updateRegistration(registration.id, { label: event.target.value })
                            }
                            maxLength={120}
                            placeholder="e.g. Delhi branch"
                          />
                        </label>
                        <div className="org-grid">
                          <label className="org-field">
                            GSTIN
                            <input
                              value={registration.gstin}
                              maxLength={15}
                              onChange={(event) => {
                                const gstin = event.target.value.toUpperCase();
                                updateRegistration(registration.id, {
                                  gstin,
                                  stateCode: STATES.some(([code]) => code === gstin.slice(0, 2))
                                    ? gstin.slice(0, 2)
                                    : registration.stateCode,
                                });
                              }}
                              placeholder="15-character GST number"
                              autoCapitalize="characters"
                            />
                          </label>
                          <label className="org-field">
                            Registered state
                            <select
                              value={registration.stateCode}
                              onChange={(event) =>
                                updateRegistration(registration.id, { stateCode: event.target.value })
                              }
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
                        <label className="org-field">
                          Registered address
                          <textarea
                            rows={2}
                            value={registration.address}
                            onChange={(event) =>
                              updateRegistration(registration.id, { address: event.target.value })
                            }
                            maxLength={1500}
                            placeholder="Address for this GST registration"
                          />
                        </label>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      className="org-small-button"
                      disabled={registrations.length >= 20}
                      onClick={() =>
                        update('gstRegistrations', [
                          ...registrations,
                          { id: crypto.randomUUID(), label: '', gstin: '', stateCode: '', address: '' },
                        ])
                      }
                    >
                      <Plus size={14} />
                      Add GST registration
                    </button>
                    <p className="org-helper">
                      {registrations.length}/20 additional registrations saved with this organization.
                    </p>
                  </section>
                  <div className="org-divider" />
                  <div className="org-grid">
                    <label className="org-field">
                      Business email
                      <input
                        type="email"
                        value={form.email}
                        onChange={(event) => update('email', event.target.value)}
                        placeholder="accounts@yourcompany.com"
                        maxLength={254}
                        autoComplete="email"
                      />
                    </label>
                    <label className="org-field">
                      Phone number
                      <input
                        type="tel"
                        value={form.phone}
                        onChange={(event) => update('phone', event.target.value)}
                        placeholder="+91"
                        maxLength={30}
                        autoComplete="tel"
                      />
                    </label>
                  </div>
                  <label className="org-field">
                    Support email
                    <input
                      type="email"
                      value={form.supportEmail || ''}
                      onChange={(event) => update('supportEmail', event.target.value)}
                      placeholder={
                        form.businessType === 'independent'
                          ? 'support@yourbusiness.com'
                          : 'support@pirento.com'
                      }
                      maxLength={254}
                    />
                    <span className="org-helper">
                      Customer support contact shown on documents. Configure the verified outgoing email
                      sender in Integrations.
                    </span>
                  </label>
                  <label className="org-field">
                    Billing profile
                    <select
                      value={form.billingProfile || 'general'}
                      onChange={(event) => update('billingProfile', event.target.value as BillingProfile)}
                    >
                      {Object.entries(BILLING_PROFILES).map(([key, value]) => (
                        <option value={key} key={key}>
                          {value.label}
                        </option>
                      ))}
                    </select>
                    <span className="org-helper">
                      {BILLING_PROFILES[form.billingProfile || 'general'].hint}. Rates and GST remain yours to
                      set.
                    </span>
                  </label>
                  <label className="org-product-selection">
                    <input
                      type="checkbox"
                      checked={Boolean(form.enableProductSelection)}
                      onChange={(event) => update('enableProductSelection', event.target.checked)}
                    />
                    <span>
                      Choose a business product on documents
                      <small>Use a product selector within this organization, as in Pirento ecosystem.</small>
                    </span>
                  </label>
                  <div className="org-info">
                    <Building2 size={17} />
                    <p>
                      Save customers, B2B buyers and vendors for this organization in Contacts, then search
                      for them while creating a document.
                    </p>
                  </div>
                </>
              )}
              {tab === 'design' && (
                <>
                  <div className="org-section-heading">
                    <h3>Your organization’s identity</h3>
                    <p>
                      This logo appears on this organization’s dashboard and new documents. Existing documents
                      keep their saved branding; you can change the logo on an editable draft.
                    </p>
                  </div>
                  <div className="org-field">
                    Organization logo
                    <div className="org-logo-upload">
                      <div className="org-upload-preview">
                        {logoReady ? (
                          <img src={form.logoUrl} alt="Organization logo" />
                        ) : (
                          <ImagePlus size={25} />
                        )}
                      </div>
                      <div className="org-upload-description">
                        <strong>{uploadName || 'Add your organization’s logo'}</strong>
                        <span>PNG, JPG or WebP · Up to 500 KB</span>
                        <div className="org-upload-actions">
                          <button
                            type="button"
                            className="org-small-button"
                            onClick={() => fileRef.current?.click()}
                            disabled={uploading}
                          >
                            {uploading ? (
                              <LoaderCircle className="org-spin" size={14} />
                            ) : (
                              <Upload size={14} />
                            )}
                            {uploading ? 'Uploading…' : 'Upload logo'}
                          </button>
                          {form.logoUrl && (
                            <button
                              type="button"
                              className="org-text-button"
                              onClick={() => {
                                update('logoUrl', '');
                                setUploadName('');
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={uploadLogo}
                      />
                    </div>
                  </div>
                  <label className="org-field">
                    Or use an image URL
                    <input
                      type="url"
                      value={form.logoUrl.startsWith('data:') ? '' : form.logoUrl}
                      onChange={(event) => {
                        update('logoUrl', event.target.value);
                        setUploadName('');
                      }}
                      placeholder="https://yourcompany.com/logo.png"
                      maxLength={2048}
                    />
                    <span className="org-helper">Use a publicly accessible HTTPS image link.</span>
                  </label>
                  <div className="org-field">
                    Brand color
                    <div className="org-colors">
                      {COLORS.map((color) => (
                        <button
                          type="button"
                          key={color}
                          className={`org-swatch ${safeAccent === color ? 'org-swatch-selected' : ''}`}
                          style={{ background: color }}
                          onClick={() => update('accentColor', color)}
                          aria-label={`Use brand color ${color}`}
                          aria-pressed={safeAccent === color}
                        >
                          {safeAccent === color && <Check size={16} />}
                        </button>
                      ))}
                      <label className="org-color-picker">
                        <input
                          type="color"
                          value={safeAccent}
                          onChange={(event) => update('accentColor', event.target.value)}
                          aria-label="Choose a custom brand color"
                        />
                        <span>{safeAccent.toUpperCase()}</span>
                      </label>
                    </div>
                  </div>
                  <div className="org-field">
                    Base brand style
                    <div className="org-template-options">
                      {(['modern', 'classic'] as const).map((template) => (
                        <button
                          key={template}
                          type="button"
                          className={`org-template ${form.template === template ? 'org-template-selected' : ''}`}
                          onClick={() => update('template', template)}
                          aria-pressed={form.template === template}
                        >
                          <div className={`org-template-art org-template-art-${template}`}>
                            <i />
                            <b />
                            <span />
                            <span />
                            <span />
                          </div>
                          <span>
                            {template === 'modern' ? 'Modern' : 'Classic'}
                            {form.template === template && <CheckCircle2 size={16} />}
                          </span>
                        </button>
                      ))}
                    </div>
                    <span className="org-helper">
                      Used when creating an organization’s first format. Manage saved formats in Invoice
                      formats.
                    </span>
                  </div>
                  <div className="org-grid">
                    <label className="org-field">
                      Invoice prefix
                      <input
                        value={form.invoicePrefix}
                        maxLength={4}
                        onChange={(event) => update('invoicePrefix', event.target.value.toUpperCase())}
                        placeholder="INV"
                      />
                    </label>
                    <label className="org-field">
                      Quotation prefix
                      <input
                        value={form.quotationPrefix}
                        maxLength={4}
                        onChange={(event) => update('quotationPrefix', event.target.value.toUpperCase())}
                        placeholder="QUO"
                      />
                    </label>
                  </div>
                  <p className="org-helper org-prefix-helper">
                    Up to 4 letters or numbers. A financial year and sequence are added automatically.
                  </p>
                  <label className="org-field">
                    Default terms & conditions
                    <textarea
                      rows={3}
                      value={form.terms}
                      onChange={(event) => update('terms', event.target.value)}
                      placeholder="Payment terms, scope notes or other conditions…"
                      maxLength={5000}
                    />
                    <span className="org-helper">You can adjust these for each document.</span>
                  </label>
                  <BrandImageUpload
                    disabled={saving || uploading}
                    onBusyChange={setUploading}
                    label="Signature image"
                    value={form.signatureImageUrl || ''}
                    onChange={(value) => update('signatureImageUrl', value)}
                  />
                  <label className="org-field">
                    Signature label
                    <input
                      value={form.signature}
                      onChange={(event) => update('signature', event.target.value)}
                      placeholder="e.g. Authorized signatory"
                      maxLength={160}
                    />
                  </label>
                  <div className="org-divider" />
                  <div className="org-section-heading">
                    <h3>Additional authorization</h3>
                    <p>
                      Add a second signatory and a company stamp, or leave space for signing after printing.
                    </p>
                  </div>
                  <label className="org-field">
                    Secondary authorized person
                    <input
                      value={form.secondarySignatureLabel || ''}
                      onChange={(event) => update('secondarySignatureLabel', event.target.value)}
                      placeholder="Name / designation"
                      maxLength={200}
                    />
                  </label>
                  <BrandImageUpload
                    disabled={saving || uploading}
                    onBusyChange={setUploading}
                    label="Secondary signature"
                    value={form.secondarySignatureImageUrl || ''}
                    onChange={(value) => update('secondarySignatureImageUrl', value)}
                  />
                  <label className="org-field">
                    Stamp label
                    <input
                      value={form.stampLabel || ''}
                      onChange={(event) => update('stampLabel', event.target.value)}
                      placeholder="Company stamp"
                      maxLength={200}
                    />
                  </label>
                  <BrandImageUpload
                    disabled={saving || uploading}
                    onBusyChange={setUploading}
                    label="Company stamp"
                    value={form.stampImageUrl || ''}
                    onChange={(value) => update('stampImageUrl', value)}
                  />
                </>
              )}
              {tab === 'payment' && (
                <>
                  <div className="org-section-heading">
                    <h3>Make payments simple</h3>
                    <p>Set the gateway, bank account and QR customers should use for this business.</p>
                  </div>
                  <label className="org-field">
                    Payment gateway
                    <select
                      value={form.paymentGateway || 'none'}
                      onChange={(event) =>
                        update('paymentGateway', event.target.value as 'razorpay' | 'cashfree' | 'none')
                      }
                    >
                      <option value="none">No online gateway</option>
                      <option value="razorpay">Razorpay</option>
                      <option value="cashfree">Cashfree</option>
                    </select>
                    <span className="org-helper">
                      Only this organization’s configured account receives its online payments. Complete
                      account setup in Integrations.
                    </span>
                  </label>
                  <div className="org-payment-banner">
                    <div>
                      <CreditCard size={23} />
                    </div>
                    <p>
                      <strong>Your payment details, on every invoice</strong>
                      <span>Bank details are optional. Add them when you’re ready.</span>
                    </p>
                  </div>
                  <label className="org-field">
                    Account holder name
                    <input
                      value={form.accountName}
                      onChange={(event) => update('accountName', event.target.value)}
                      placeholder="Name as registered with the bank"
                      maxLength={160}
                    />
                  </label>
                  <label className="org-field">
                    Bank name
                    <input
                      value={form.bankName}
                      onChange={(event) => update('bankName', event.target.value)}
                      placeholder="Enter your bank name"
                      maxLength={120}
                    />
                  </label>
                  <div className="org-grid">
                    <label className="org-field">
                      Account number
                      <input
                        value={form.accountNumber}
                        onChange={(event) => update('accountNumber', event.target.value)}
                        placeholder="Account number"
                        inputMode="numeric"
                        maxLength={40}
                        autoComplete="off"
                      />
                    </label>
                    <label className="org-field">
                      IFSC code
                      <input
                        value={form.ifsc}
                        onChange={(event) => update('ifsc', event.target.value.toUpperCase())}
                        placeholder="11-character IFSC code"
                        maxLength={11}
                        autoCapitalize="characters"
                      />
                    </label>
                  </div>
                  <div className="org-grid">
                    <label className="org-field">
                      Account type
                      <select
                        value={form.accountType || ''}
                        onChange={(event) => update('accountType', event.target.value)}
                      >
                        <option value="">Select account type</option>
                        <option>Current</option>
                        <option>Savings</option>
                        <option>Other</option>
                      </select>
                    </label>
                    <label className="org-field">
                      Bank branch
                      <input
                        value={form.bankBranch || ''}
                        onChange={(event) => update('bankBranch', event.target.value)}
                        maxLength={200}
                        placeholder="Branch and city"
                      />
                    </label>
                  </div>
                  <BrandImageUpload
                    disabled={saving || uploading}
                    onBusyChange={setUploading}
                    label="Payment QR"
                    value={form.paymentQrUrl || ''}
                    onChange={(value) => update('paymentQrUrl', value)}
                  />
                  <p className="org-helper">
                    Upload, replace or remove this business’s QR anytime. Bank and QR changes apply to new
                    documents; existing documents keep their saved payment details. The QR appears when
                    enabled in the selected format.
                  </p>
                  <div className="org-info">
                    <CheckCircle2 size={17} />
                    <p>
                      Check your account number and IFSC carefully. These details will be visible on documents
                      you share.
                    </p>
                  </div>
                </>
              )}
            </div>
            <aside className="org-preview-area" aria-label="Live branding preview">
              <div className="org-preview-label">
                <span /> LIVE PREVIEW
              </div>
              <div className={`org-preview-sheet org-preview-${form.template}`}>
                <div className="org-preview-brand">
                  {logoReady ? (
                    <img src={form.logoUrl} alt="" />
                  ) : (
                    <div className="org-preview-monogram">{initials}</div>
                  )}
                  <strong>{form.name || 'Your organization'}</strong>
                </div>
                <p className="org-preview-company">
                  {form.legalName || 'Legal business name'}
                  {form.tradeName && (
                    <>
                      <br />
                      Trade name: {form.tradeName}
                    </>
                  )}
                  {form.gstin && (
                    <>
                      <br />
                      GSTIN: {form.gstin}
                    </>
                  )}
                  {form.supportEmail && (
                    <>
                      <br />
                      Support: {form.supportEmail}
                    </>
                  )}
                </p>
                <div className="org-preview-title">
                  <h4>INVOICE</h4>
                  <span>{form.invoicePrefix || 'INV'}/2627/0001</span>
                </div>
                <div className="org-preview-recipient">
                  <small>BILL TO</small>
                  <span>Customer name</span>
                  <i />
                  <i />
                </div>
                <div className="org-preview-table">
                  <span>Description</span>
                  <span>Amount</span>
                </div>
                <div className="org-preview-row">
                  <i />
                  <i />
                </div>
                <div className="org-preview-row">
                  <i />
                  <i />
                </div>
                <div className="org-preview-total">
                  <span>Total amount</span>
                  <strong>₹ 0.00</strong>
                </div>
                {tab === 'payment' && (form.bankName || form.accountNumber) ? (
                  <div className="org-preview-bank">
                    <small>PAYMENT DETAILS</small>
                    <span>{form.bankName || 'Your bank'}</span>
                    {form.accountName && <span>{form.accountName}</span>}
                    {form.accountNumber && <span>A/c: {form.accountNumber}</span>}
                    {form.ifsc && <span>IFSC: {form.ifsc}</span>}
                  </div>
                ) : (
                  <div className="org-preview-note">
                    {form.terms || 'Your terms and payment details appear here.'}
                  </div>
                )}
                {tab === 'payment' && form.paymentQrUrl && (
                  <img className="org-preview-qr" src={form.paymentQrUrl} alt="Payment QR preview" />
                )}
                <div className="org-preview-signature">
                  {form.signatureImageUrl && <img src={form.signatureImageUrl} alt="Signature preview" />}
                  {form.signature || 'Authorized signatory'}
                </div>
              </div>
              <p className="org-preview-caption">
                Your identity. A consistent, professional
                <br />
                look on every document.
              </p>
              <div className="org-preview-company-note">
                <Building2 size={13} />
                <span>
                  {form.businessType === 'independent'
                    ? 'Independent legal business.'
                    : 'Venturecore division.'}
                  <br />
                  Its own saved seller and payment details.
                </span>
              </div>
            </aside>
          </div>
          <footer className="org-footer">
            {error && (
              <div className="org-error" role="alert">
                {error}
              </div>
            )}
            <div className="org-footer-actions">
              <span>
                <span className="org-footer-dot" /> Branding updates the dashboard and future documents
              </span>
              <div>
                <button
                  type="button"
                  className="org-secondary-button"
                  onClick={onClose}
                  disabled={saving || uploading}
                >
                  Cancel
                </button>
                <button type="submit" className="org-primary-button" disabled={saving || uploading}>
                  {saving ? (
                    <>
                      <LoaderCircle size={16} className="org-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      {organization ? 'Save changes' : 'Create organization'}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </div>
          </footer>
        </form>
      </div>
    </section>
  );
}
