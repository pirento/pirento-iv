import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FileText,
  ImagePlus,
  LayoutTemplate,
  LoaderCircle,
  Palette,
  Pencil,
  Plus,
  QrCode,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { defaultFormatFor } from '../../../shared/types';
import { isIndependentBusiness, organizationSupportEmail } from '../../../shared/business-identity';
import type { ManagerNavigation, ManagerPage } from '../../app/manager-page';
import { documentColors } from '../../../shared/pdf';
import { TEMPLATE_PRESETS } from '../../../shared/template-presets';
import type { FormatInput, InvoiceFormat, Organization } from '../../../shared/types';
import './formats.css';

interface FormatManagerProps extends ManagerNavigation {
  organization: Organization;
  formats: InvoiceFormat[];
  onSave: (input: FormatInput, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const COLORS = ['#26705b', '#2c526b', '#6e52a3', '#b96739', '#a44969', '#263744'];
const LAYOUTS = [
  { value: 'modern', label: 'Modern', description: 'A confident touch of color' },
  { value: 'classic', label: 'Classic', description: 'Balanced and traditional' },
  { value: 'minimal', label: 'Minimal', description: 'Clean, simple and spacious' },
  { value: 'ledger', label: 'Ledger', description: 'Structured details and clear columns' },
  { value: 'sidebar', label: 'Sidebar', description: 'A bold band of brand identity' },
] as const;
const OPTIONS = [
  { key: 'showLogo', label: 'Organization logo', hint: 'Use this format’s logo or inherit your brand logo' },
  { key: 'showHsn', label: 'HSN / SAC code', hint: 'Product and service classification' },
  { key: 'showUnit', label: 'Unit of measure', hint: 'Nos, hours, projects and more' },
  { key: 'showGstRate', label: 'Item GST rate', hint: 'Show the tax rate for each item' },
  { key: 'showBankDetails', label: 'Bank details', hint: 'Payment information for this organization' },
  { key: 'showAmountInWords', label: 'Amount in words', hint: 'Write out the total payable' },
  { key: 'showSignature', label: 'Signature area', hint: 'Space for an authorized signatory' },
  {
    key: 'showSecondarySignature',
    label: 'Secondary signature',
    hint: 'A second authorized person or space to sign',
  },
  { key: 'showStamp', label: 'Company stamp', hint: 'Uploaded stamp or an empty stamping area' },
  { key: 'showPaymentQr', label: 'Payment QR', hint: 'Uses the payment QR image in business settings' },
] as const;
const CATEGORIES = ['All formats', 'Business', 'Services', 'Products', 'Shipping', 'Custom'] as const;
type FormatCategory = (typeof CATEGORIES)[number];
const presetFor = (format: InvoiceFormat) =>
  TEMPLATE_PRESETS.find((preset) => preset.key === format.presetKey);
const formatCategory = (format: InvoiceFormat) => presetFor(format)?.category ?? 'Custom';

function asInput(format: InvoiceFormat): FormatInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = format;
  return input;
}

function FormatSample({
  organization,
  format: storedFormat,
  small = false,
}: {
  organization: Organization;
  format: FormatInput;
  small?: boolean;
}) {
  const format = { ...defaultFormatFor(organization), ...storedFormat };
  const initials = organization.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  const { accent, onAccent, accentText } = documentColors(format.accentColor);
  const logo = format.logoUrl || organization.logoUrl;
  const fontSize = format.fontSize ?? 9;
  const style = {
    '--fmt-accent': accent,
    '--fmt-on-accent': onAccent,
    '--fmt-accent-text': accentText,
    '--fmt-body-font': `${fontSize * 0.75}px`,
    '--fmt-brand-font': `${fontSize * 1.25}px`,
    '--fmt-heading-font': `${fontSize * 1.45}px`,
    '--fmt-paper-margin': `${(format.pageMargin ?? 14) * 1.6}px`,
    '--fmt-logo-size': `${(format.logoWidth ?? 72) * 0.58}px`,
    '--fmt-signature-size': `${(format.signatureWidth ?? 140) * 0.55}px`,
    '--fmt-stamp-size': `${(format.stampWidth ?? 110) * 0.55}px`,
    '--fmt-qr-size': `${(format.paymentQrWidth ?? 110) * 0.55}px`,
  } as CSSProperties;
  return (
    <div
      className={`fmt-sample fmt-sample-${format.layout} fmt-density-${format.density} fmt-table-${format.tableStyle ?? 'ruled'} fmt-paper-${(format.pageSize ?? 'A4').toLowerCase()} fmt-paper-${format.orientation ?? 'portrait'} ${small ? 'fmt-sample-small' : ''}`}
      style={style}
      aria-label="Sample invoice preview"
    >
      <div className="fmt-sample-heading">
        <div className="fmt-sample-brand">
          {format.showLogo &&
            (logo ? (
              <img src={logo} alt="Organization logo preview" />
            ) : (
              <span className="fmt-sample-monogram">{initials}</span>
            ))}
          <div>
            <strong>{organization.name}</strong>
            <span>{isIndependentBusiness(organization) ? 'Independent business' : 'A division of'}</span>
            <p>{organization.legalName}</p>
          </div>
        </div>
        <div className="fmt-sample-title">
          <strong>INVOICE</strong>
          <span>{organization.invoicePrefix}/SAMPLE</span>
        </div>
      </div>
      <div className="fmt-sample-customer">
        <div>
          <small>BILL TO</small>
          <strong>Customer name</strong>
          <span>Customer address</span>
        </div>
        <div>
          <small>DOCUMENT DETAILS</small>
          <span>Invoice date · DD/MM/YYYY</span>
          <span>Due date · DD/MM/YYYY</span>
        </div>
      </div>
      <table className="fmt-sample-table">
        <thead>
          <tr>
            <th>Description</th>
            {format.showHsn && <th>HSN/SAC</th>}
            <th>Qty</th>
            {format.showUnit && <th>Unit</th>}
            <th>Rate</th>
            {format.showGstRate && <th>GST</th>}
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Sample service</td>
            {format.showHsn && <td>—</td>}
            <td>1</td>
            {format.showUnit && <td>Service</td>}
            <td>1,000.00</td>
            {format.showGstRate && <td>18%</td>}
            <td>1,000.00</td>
          </tr>
          <tr>
            <td>Sample product</td>
            {format.showHsn && <td>—</td>}
            <td>1</td>
            {format.showUnit && <td>Nos</td>}
            <td>500.00</td>
            {format.showGstRate && <td>12%</td>}
            <td>500.00</td>
          </tr>
        </tbody>
      </table>
      <div className="fmt-sample-summary">
        <div>
          <span>Subtotal</span>
          <span>₹1,500.00</span>
        </div>
        <div>
          <span>CGST + SGST</span>
          <span>₹240.00</span>
        </div>
        <div className="fmt-sample-total">
          <strong>Total amount</strong>
          <strong>₹1,740.00</strong>
        </div>
      </div>
      {format.showAmountInWords && (
        <p className="fmt-sample-words">
          <strong>Amount in words</strong>One thousand seven hundred forty rupees only.
        </p>
      )}
      <div className="fmt-sample-bottom">
        {format.showBankDetails && (
          <div className="fmt-sample-bank">
            <small>PAYMENT DETAILS</small>
            <span>{organization.bankName || 'Your bank name'}</span>
            <span>Account details from business settings</span>
          </div>
        )}
        {format.showPaymentQr &&
          (organization.paymentQrUrl ? (
            <figure className="fmt-sample-qr">
              <img src={organization.paymentQrUrl} alt="Payment QR preview" />
              <figcaption>Scan to pay</figcaption>
            </figure>
          ) : (
            <div className="fmt-sample-qr-placeholder">
              <QrCode size={20} />
              <span>Add payment QR in business settings</span>
            </div>
          ))}
        {format.showSignature && (
          <div className="fmt-sample-signature">
            {organization.signatureImageUrl && (
              <img src={organization.signatureImageUrl} alt="Signature preview" />
            )}
            <span>{organization.signature || 'Authorized signatory'}</span>
          </div>
        )}
      </div>
      <div className="fmt-sample-authorizations">
        {format.showSecondarySignature && (
          <div className="fmt-signoff-box">
            {organization.secondarySignatureImageUrl && (
              <img src={organization.secondarySignatureImageUrl} alt="Secondary signature preview" />
            )}
            <span>{organization.secondarySignatureLabel || 'Secondary authorized signatory'}</span>
          </div>
        )}
        {format.showStamp && (
          <div className="fmt-signoff-box fmt-stamp-box">
            {organization.stampImageUrl && <img src={organization.stampImageUrl} alt="Stamp preview" />}
            <span>{organization.stampLabel || 'Company stamp'}</span>
          </div>
        )}
      </div>
      {format.footerText && <p className="fmt-sample-footer">{format.footerText}</p>}
    </div>
  );
}

function FormatDesigner({
  organization,
  source,
  duplicate,
  first,
  onSave,
  onClose,
}: {
  organization: Organization;
  source?: InvoiceFormat;
  duplicate: boolean;
  first: boolean;
  onSave: FormatManagerProps['onSave'];
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormatInput>(() => {
    const base = { ...asInput(defaultFormatFor(organization)), ...(source ? asInput(source) : {}) };
    return {
      ...base,
      name: duplicate ? `${base.name.slice(0, 94)} copy` : source ? base.name : '',
      presetKey: duplicate ? '' : base.presetKey,
      isDefault: source && !duplicate ? source.isDefault : first,
    };
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploadName, setUploadName] = useState(source?.logoUrl ? 'Custom format logo' : '');
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  busyRef.current = saving || uploading;
  const editing = !!source && !duplicate;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const update = <K extends keyof FormatInput>(key: K, value: FormatInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  function applyPreset(key: string) {
    if (!key) {
      update('presetKey', '');
      return;
    }
    const preset = TEMPLATE_PRESETS.find((value) => value.key === key);
    if (!preset) return;
    setForm((current) => ({
      ...asInput(defaultFormatFor(organization)),
      ...preset.settings,
      name:
        !current.name ||
        current.name === TEMPLATE_PRESETS.find((value) => value.key === current.presetKey)?.name
          ? preset.name
          : current.name,
      description: preset.description,
      presetKey: preset.key,
      logoUrl: current.logoUrl,
      isDefault: current.isDefault,
    }));
  }
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busyRef.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPG or WebP image for your format logo.');
      return;
    }
    if (file.size > 500 * 1024) {
      setError('Your logo must be smaller than 500 KB.');
      return;
    }
    busyRef.current = true;
    setUploading(true);
    setError('');
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('This image could not be read. Please choose another file.'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('This file could not be opened as an image.'));
        image.src = data;
      });
      setForm((current) => ({ ...current, logoUrl: data, showLogo: true }));
      setUploadName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload this logo.');
    } finally {
      busyRef.current = false;
      setUploading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!form.name.trim()) {
      setError('Give your format a name so you can find it later.');
      nameRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(
        {
          ...form,
          name: form.name.trim(),
          description: form.description?.trim() || '',
          footerText: form.footerText.trim(),
        },
        editing ? source.id : undefined,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save this format. Please try again.');
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="fmt-designer-page">
      <button
        className="button secondary fmt-back"
        type="button"
        onClick={onClose}
        disabled={saving || uploading}
      >
        <ArrowLeft size={16} />
        Back to invoice formats
      </button>
      <section className="fmt-designer panel" aria-labelledby="fmt-designer-title" ref={panelRef}>
        <header className="fmt-designer-header">
          <div className="fmt-header-icon">
            <Palette size={23} />
          </div>
          <div>
            <span className="fmt-eyebrow">DESIGNED FOR YOUR BUSINESS</span>
            <h2 id="fmt-designer-title">
              {editing
                ? 'Edit invoice format'
                : duplicate
                  ? 'Duplicate invoice format'
                  : 'Create invoice format'}
            </h2>
            <p>{organization.name}</p>
          </div>
        </header>
        <form onSubmit={submit} className="fmt-designer-form">
          <div className="fmt-designer-body">
            <div className="fmt-settings">
              <label className="fmt-field fmt-preset-field">
                Start from a template
                <select
                  aria-label="Start from a template"
                  value={form.presetKey ?? ''}
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  <option value="">Custom design</option>
                  {(['Business', 'Services', 'Products', 'Shipping'] as const).map((category) => (
                    <optgroup key={category} label={category}>
                      {TEMPLATE_PRESETS.filter((preset) => preset.category === category).map((preset) => (
                        <option key={preset.key} value={preset.key}>
                          {preset.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="fmt-helper">
                  15 starting points. Selecting one replaces the design settings below.
                </span>
              </label>
              <label className="fmt-field">
                Format name <span>*</span>
                <input
                  ref={nameRef}
                  value={form.name}
                  onChange={(event) => update('name', event.target.value)}
                  placeholder="e.g. Service invoice, Product invoice"
                  maxLength={100}
                  required
                />
              </label>
              <label className="fmt-field">
                Description
                <textarea
                  rows={2}
                  value={form.description ?? ''}
                  onChange={(event) => update('description', event.target.value)}
                  maxLength={500}
                  placeholder="When should your team use this format?"
                />
              </label>
              <fieldset className="fmt-fieldset">
                <legend>Choose a layout</legend>
                <div className="fmt-layouts">
                  {LAYOUTS.map((layout) => (
                    <button
                      type="button"
                      key={layout.value}
                      aria-pressed={form.layout === layout.value}
                      className={`fmt-layout-option ${form.layout === layout.value ? 'selected' : ''}`}
                      onClick={() => update('layout', layout.value)}
                      title={layout.description}
                    >
                      <div
                        className={`fmt-layout-art fmt-art-${layout.value}`}
                        style={{ '--fmt-accent': form.accentColor } as CSSProperties}
                      >
                        <i />
                        <b />
                        <span />
                        <span />
                        <span />
                      </div>
                      <span>
                        {layout.label}
                        {form.layout === layout.value && <CheckCircle2 size={13} />}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="fmt-fieldset">
                <legend>Accent color</legend>
                <div className="fmt-color-options">
                  {COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      style={{ background: color }}
                      aria-label={`Use color ${color}`}
                      aria-pressed={form.accentColor === color}
                      onClick={() => update('accentColor', color)}
                      className={`fmt-swatch ${form.accentColor === color ? 'selected' : ''}`}
                    >
                      {form.accentColor === color && <Check size={15} />}
                    </button>
                  ))}
                  <label className="fmt-color-picker">
                    <input
                      type="color"
                      value={form.accentColor}
                      onChange={(event) => update('accentColor', event.target.value)}
                      aria-label="Custom accent color"
                    />
                    <span>{form.accentColor.toUpperCase()}</span>
                  </label>
                </div>
              </fieldset>
              <fieldset className="fmt-fieldset">
                <legend>Spacing</legend>
                <div className="fmt-spacing">
                  {(['comfortable', 'compact'] as const).map((density) => (
                    <button
                      type="button"
                      key={density}
                      aria-pressed={form.density === density}
                      className={form.density === density ? 'selected' : ''}
                      onClick={() => update('density', density)}
                    >
                      {density === 'comfortable' ? 'Comfortable' : 'Compact'}
                      {form.density === density && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </fieldset>
              <section className="fmt-control-section" aria-labelledby="fmt-paper-heading">
                <h3 id="fmt-paper-heading">Paper & typography</h3>
                <p>Set up the page for printing and PDF downloads.</p>
                <div className="fmt-control-grid">
                  <label className="fmt-field">
                    Paper size
                    <select
                      aria-label="Paper size"
                      value={form.pageSize ?? 'A4'}
                      onChange={(event) => update('pageSize', event.target.value as FormatInput['pageSize'])}
                    >
                      <option value="A4">A4 · 210 × 297 mm</option>
                      <option value="A5">A5 · 148 × 210 mm</option>
                      <option value="LETTER">Letter · 8.5 × 11 in</option>
                    </select>
                  </label>
                  <label className="fmt-field">
                    Orientation
                    <select
                      aria-label="Orientation"
                      value={form.orientation ?? 'portrait'}
                      onChange={(event) =>
                        update('orientation', event.target.value as FormatInput['orientation'])
                      }
                    >
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </label>
                </div>
                <label className="fmt-range-field">
                  <span>
                    Text size<strong>{form.fontSize ?? 9} pt</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Text size"
                    min={8}
                    max={14}
                    step={1}
                    value={form.fontSize ?? 9}
                    onChange={(event) => update('fontSize', Number(event.target.value))}
                  />
                  <small>
                    8 pt · compact<span>14 pt · larger text</span>
                  </small>
                </label>
                <label className="fmt-range-field">
                  <span>
                    Page margin<strong>{form.pageMargin ?? 14} mm</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Page margin"
                    min={8}
                    max={24}
                    step={1}
                    value={form.pageMargin ?? 14}
                    onChange={(event) => update('pageMargin', Number(event.target.value))}
                  />
                  <small>
                    8 mm · more space<span>24 mm · wider margins</span>
                  </small>
                </label>
                <label className="fmt-field">
                  Table style
                  <select
                    aria-label="Table style"
                    value={form.tableStyle ?? 'ruled'}
                    onChange={(event) =>
                      update('tableStyle', event.target.value as FormatInput['tableStyle'])
                    }
                  >
                    <option value="ruled">Ruled · clear row lines</option>
                    <option value="striped">Striped · alternating rows</option>
                    <option value="plain">Plain · minimal lines</option>
                  </select>
                </label>
              </section>
              <section className="fmt-control-section" aria-labelledby="fmt-logo-heading">
                <h3 id="fmt-logo-heading">Logo for this format</h3>
                <p>Inherit your organization’s logo or upload a different one.</p>
                <div className="fmt-logo-upload">
                  <div className="fmt-logo-thumb">
                    {form.logoUrl || organization.logoUrl ? (
                      <img src={form.logoUrl || organization.logoUrl} alt="Current format logo" />
                    ) : (
                      <ImagePlus size={25} />
                    )}
                  </div>
                  <div>
                    <strong>
                      {form.logoUrl
                        ? uploadName || 'Custom format logo'
                        : organization.logoUrl
                          ? 'Using organization logo'
                          : 'No logo added yet'}
                    </strong>
                    <span>PNG, JPG or WebP · Up to 500 KB</span>
                    <div>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => fileRef.current?.click()}
                        disabled={saving || uploading}
                      >
                        {uploading ? <LoaderCircle size={13} className="fmt-spin" /> : <Upload size={13} />}
                        {uploading ? 'Uploading…' : 'Upload logo'}
                      </button>
                      {form.logoUrl && (
                        <button
                          type="button"
                          className="fmt-remove-logo"
                          disabled={saving || uploading}
                          onClick={() => {
                            update('logoUrl', '');
                            setUploadName('');
                          }}
                        >
                          Use brand logo
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
                    aria-label="Upload format logo"
                  />
                </div>
                <label className="fmt-range-field">
                  <span>
                    Logo width<strong>{form.logoWidth ?? 72} px</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Logo width"
                    min={32}
                    max={140}
                    step={1}
                    value={form.logoWidth ?? 72}
                    onChange={(event) => update('logoWidth', Number(event.target.value))}
                  />
                  <small>
                    32 px<span>140 px</span>
                  </small>
                </label>
              </section>
              <fieldset className="fmt-fieldset fmt-details-fieldset">
                <legend>Details to include</legend>
                <p className="fmt-helper">Choose the information your customers see.</p>
                {OPTIONS.map((option) => (
                  <label className="fmt-toggle-row" key={option.key}>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.hint}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={!!form[option.key]}
                      onChange={(event) => update(option.key, event.target.checked)}
                    />
                    <span className="fmt-toggle" aria-hidden="true" />
                  </label>
                ))}
              </fieldset>
              {form.showSignature && (
                <label className="fmt-range-field">
                  <span>
                    Signature width<strong>{form.signatureWidth ?? 140} px</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Signature width"
                    min={70}
                    max={220}
                    step={1}
                    value={form.signatureWidth ?? 140}
                    onChange={(event) => update('signatureWidth', Number(event.target.value))}
                  />
                  <small>
                    70 px<span>220 px</span>
                  </small>
                  {!organization.signatureImageUrl && (
                    <span className="fmt-helper">
                      Add a signature image in business settings to show it here.
                    </span>
                  )}
                </label>
              )}
              {form.showStamp && (
                <label className="fmt-range-field">
                  <span>
                    Stamp size<strong>{form.stampWidth ?? 110} px</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Stamp size"
                    min={70}
                    max={160}
                    step={1}
                    value={form.stampWidth ?? 110}
                    onChange={(event) => update('stampWidth', Number(event.target.value))}
                  />
                  <small>
                    70 px<span>160 px</span>
                  </small>
                </label>
              )}
              {form.showPaymentQr && (
                <label className="fmt-range-field">
                  <span>
                    Payment QR width<strong>{form.paymentQrWidth ?? 110} px</strong>
                  </span>
                  <input
                    type="range"
                    aria-label="Payment QR width"
                    min={70}
                    max={160}
                    step={1}
                    value={form.paymentQrWidth ?? 110}
                    onChange={(event) => update('paymentQrWidth', Number(event.target.value))}
                  />
                  <small>
                    70 px<span>160 px</span>
                  </small>
                  {!organization.paymentQrUrl && (
                    <span className="fmt-helper">
                      Add a payment QR image in business settings. The placeholder is not printed.
                    </span>
                  )}
                </label>
              )}
              <label className="fmt-field">
                Footer message
                <textarea
                  value={form.footerText}
                  onChange={(event) => update('footerText', event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="Thank you for your business."
                />
                <span className="fmt-helper">
                  A short note at the bottom of every document. {form.footerText.length}/500
                </span>
              </label>
              <label className="fmt-default-choice">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  disabled={first || (editing && source.isDefault)}
                  onChange={(event) => update('isDefault', event.target.checked)}
                />
                <span>
                  <strong>Use as default</strong>
                  <small>
                    {editing && source.isDefault
                      ? 'To change the default, choose another saved format.'
                      : 'Preselect this format for new invoices and quotations.'}
                  </small>
                </span>
              </label>
            </div>
            <aside className="fmt-live-preview">
              <div className="fmt-preview-label">
                <Eye size={14} />
                <span>SAMPLE PREVIEW</span>
                <span className="fmt-live-dot" />
                Live
              </div>
              <div className="fmt-preview-paper-label">
                {form.pageSize ?? 'A4'}
                <span>·</span>
                {form.orientation ?? 'portrait'}
                <span>·</span>
                {form.fontSize ?? 9} pt
              </div>
              <FormatSample organization={organization} format={form} />
              <p className="fmt-preview-caption">
                Illustrative customer and items. Preview scaled to fit.
                <br />
                Your saved documents use their own details.
              </p>
              <div className="fmt-preview-note">
                <ShieldCheck size={17} />
                <p>
                  {isIndependentBusiness(organization)
                    ? 'Independent business identity.'
                    : 'Your division’s business identity.'}
                  <span>{organization.legalName}</span>
                  <span>{organizationSupportEmail(organization)}</span>
                </p>
              </div>
            </aside>
          </div>
          <footer className="fmt-designer-footer">
            {error && (
              <div className="fmt-error" role="alert">
                {error}
              </div>
            )}
            <div>
              <span className="fmt-footer-hint">
                <CheckCircle2 size={14} />
                Saved documents keep their original format.
              </span>
              <div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={saving || uploading}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button type="submit" className="button primary" disabled={saving || uploading}>
                  {saving ? <LoaderCircle size={15} className="fmt-spin" /> : <Check size={15} />}
                  {saving ? 'Saving…' : 'Save format'}
                </button>
              </div>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function FormatManager({
  organization,
  formats,
  onSave,
  onDelete,
  page: requestedPage,
  onNavigate,
}: FormatManagerProps) {
  const [localPage, setLocalPage] = useState<ManagerPage | null>(null);
  const childPage = requestedPage === undefined ? localPage : requestedPage;
  const navigate = (next: ManagerPage | null) => {
    setError('');
    if (onNavigate) onNavigate(next);
    else setLocalPage(next);
  };
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [category, setCategory] = useState<FormatCategory>('All formats');
  const [search, setSearch] = useState('');
  const organizationFormats = formats.filter((format) => format.organizationId === organization.id);
  const defaultFormat = organizationFormats.find((format) => format.isDefault);
  const visibleFormats = organizationFormats.filter(
    (format) =>
      (category === 'All formats' || formatCategory(format) === category) &&
      `${format.name} ${format.description || presetFor(format)?.description || ''} ${format.layout} ${formatCategory(format)}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  useEffect(() => {
    setLocalPage(null);
    setError('');
    setCategory('All formats');
    setSearch('');
  }, [organization.id]);

  async function makeDefault(format: InvoiceFormat) {
    if (busyId) return;
    setBusyId(format.id);
    setError('');
    try {
      await onSave({ ...asInput(format), isDefault: true }, format.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to change the default format.');
    } finally {
      setBusyId('');
    }
  }

  async function deleteFormat(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError('');
    try {
      await onDelete(id);
      navigate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete this format.');
    } finally {
      setBusyId('');
    }
  }

  if (childPage) {
    const source = childPage.id
      ? organizationFormats.find((format) => format.id === childPage.id)
      : undefined;
    if ((childPage.action !== 'new' && !source) || (childPage.id && !source))
      return (
        <section className="panel fmt-page-message">
          <h2>Invoice format not found</h2>
          <p>This format may no longer be available in {organization.name}.</p>
          <button className="button secondary" onClick={() => navigate(null)}>
            <ArrowLeft size={16} />
            Back to invoice formats
          </button>
        </section>
      );
    if (childPage.action === 'delete' && source)
      return (
        <section className="panel fmt-delete-page" aria-labelledby="format-delete-heading">
          <button className="button secondary" onClick={() => navigate(null)} disabled={!!busyId}>
            <ArrowLeft size={16} />
            Back to invoice formats
          </button>
          <div className="page-heading">
            <div>
              <h2 id="format-delete-heading">Delete {source.name}?</h2>
              <p>
                Saved documents keep their original design. This format will no longer be available for new
                documents.
              </p>
            </div>
          </div>
          <div className="fmt-delete-page-preview">
            <FormatSample organization={organization} format={source} />
          </div>
          {(source.isDefault || organizationFormats.length === 1) && (
            <p className="fmt-error">Choose another default format before deleting this one.</p>
          )}
          {error && (
            <p className="fmt-error" role="alert">
              {error}
            </p>
          )}
          <div className="fmt-delete-page-actions">
            <button className="button secondary" disabled={!!busyId} onClick={() => navigate(null)}>
              Keep format
            </button>
            <button
              className="button danger"
              disabled={!!busyId || source.isDefault || organizationFormats.length === 1}
              onClick={() => void deleteFormat(source.id)}
            >
              {busyId ? 'Deleting…' : 'Delete format'}
            </button>
          </div>
        </section>
      );
    return (
      <FormatDesigner
        key={`${childPage.action}-${childPage.id || 'new'}`}
        organization={organization}
        source={source}
        duplicate={childPage.action === 'new' && Boolean(source)}
        first={organizationFormats.length === 0}
        onSave={onSave}
        onClose={() => navigate(null)}
      />
    );
  }
  return (
    <div className="fmt-page">
      <div className="page-heading">
        <div>
          <div className="page-eyebrow">MAKE EVERY DOCUMENT YOURS</div>
          <h1>
            Invoice formats<span className="heading-dot">.</span>
          </h1>
          <p>Design, save and reuse document formats for {organization.name}.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setError('');
            navigate({ action: 'new' });
          }}
          disabled={!!busyId}
        >
          <Plus size={16} />
          Create format
        </button>
      </div>
      <div className="fmt-intro">
        <div className="fmt-intro-icon">
          <LayoutTemplate size={28} />
        </div>
        <div>
          <h2>Your brand, on every page.</h2>
          <p>From professional fees to product orders. Find a format, then make it your own.</p>
          <div className="fmt-intro-badges">
            <span>
              <Check size={12} />
              15 ready-to-use templates
            </span>
            <span>
              <Check size={12} />5 layout styles
            </span>
            <span>
              <Check size={12} />
              Print & PDF ready
            </span>
          </div>
        </div>
        <div className="fmt-library-count">
          <strong>{organizationFormats.length.toString().padStart(2, '0')}</strong>
          <span>SAVED {organizationFormats.length === 1 ? 'FORMAT' : 'FORMATS'}</span>
        </div>
      </div>
      {error && (
        <div className="fmt-error fmt-page-error" role="alert">
          {error}
          <button className="fmt-icon-button" aria-label="Dismiss format error" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="fmt-section-heading">
        <div>
          <h2>Your format library</h2>
          <p>
            {defaultFormat
              ? `${defaultFormat.name} is your default for new documents.`
              : 'Create your first format to get started.'}
          </p>
        </div>
        <span>
          <FileText size={13} />
          {organization.name}
        </span>
      </div>
      <div className="fmt-library-toolbar">
        <div className="fmt-category-tabs" aria-label="Filter formats by category">
          {CATEGORIES.map((value) => {
            const count =
              value === 'All formats'
                ? organizationFormats.length
                : organizationFormats.filter((format) => formatCategory(format) === value).length;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                className={category === value ? 'selected' : ''}
                onClick={() => setCategory(value)}
              >
                {value}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
        <label className="fmt-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search formats…"
            aria-label="Search invoice formats"
          />
          {search && (
            <button aria-label="Clear format search" type="button" onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      <div className="fmt-results-label" aria-live="polite">
        {visibleFormats.length} {visibleFormats.length === 1 ? 'format' : 'formats'}
        {category !== 'All formats' ? ` in ${category.toLowerCase()}` : ''}
        {search.trim() ? ` matching “${search.trim()}”` : ''}
      </div>
      {!visibleFormats.length && (
        <div className="fmt-empty">
          <Search size={26} />
          <h3>No formats found</h3>
          <p>Try another name or category, or create a format for this organization.</p>
          <button
            className="button secondary"
            onClick={() => {
              setSearch('');
              setCategory('All formats');
            }}
          >
            Show all formats
          </button>
        </div>
      )}
      <div className="fmt-library">
        {visibleFormats.map((format) => (
          <article className={`fmt-card ${format.isDefault ? 'fmt-default-card' : ''}`} key={format.id}>
            <div className="fmt-card-art">
              <span className="fmt-card-sample-label">SAMPLE PREVIEW</span>
              {format.isDefault && (
                <span className="fmt-default-badge">
                  <Star size={10} fill="currentColor" />
                  Default
                </span>
              )}
              <FormatSample organization={organization} format={format} small />
            </div>
            <div className="fmt-card-info">
              <div className="fmt-card-title">
                <h3>{format.name}</h3>
                <span
                  className="fmt-card-color"
                  style={{ background: format.accentColor }}
                  title={`Accent color ${format.accentColor}`}
                />
              </div>
              <p className="fmt-card-meta">
                {formatCategory(format)}
                <span>·</span>
                {format.layout}
                <span>·</span>
                {format.pageSize ?? 'A4'} {format.orientation ?? 'portrait'}
              </p>
              <p className="fmt-card-description">
                {format.description ||
                  presetFor(format)?.description ||
                  'A custom format for your organization’s documents.'}
              </p>
              <div className="fmt-card-actions">
                <button
                  className="button secondary"
                  disabled={!!busyId}
                  onClick={() => navigate({ action: 'edit', id: format.id })}
                >
                  <Pencil size={13} />
                  Customize
                </button>
                <button
                  className="fmt-icon-button"
                  title="Duplicate format"
                  aria-label={`Duplicate ${format.name}`}
                  disabled={!!busyId}
                  onClick={() => navigate({ action: 'new', id: format.id })}
                >
                  <Copy size={15} />
                </button>
                <button
                  className="fmt-icon-button fmt-delete-button"
                  title={
                    format.isDefault ? 'Choose another default before deleting this format' : 'Delete format'
                  }
                  aria-label={`Delete ${format.name}`}
                  disabled={!!busyId || format.isDefault || organizationFormats.length === 1}
                  onClick={() => navigate({ action: 'delete', id: format.id })}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <button
                className={`fmt-make-default ${format.isDefault ? 'is-default' : ''}`}
                disabled={!!busyId || format.isDefault}
                onClick={() => void makeDefault(format)}
              >
                {busyId === format.id ? (
                  <LoaderCircle size={13} className="fmt-spin" />
                ) : format.isDefault ? (
                  <CheckCircle2 size={13} />
                ) : (
                  <Star size={13} />
                )}
                {format.isDefault ? 'Default for this organization' : 'Use as default'}
                {!format.isDefault && <ArrowRight size={13} />}
              </button>
            </div>
          </article>
        ))}
        <button className="fmt-new-card" disabled={!!busyId} onClick={() => navigate({ action: 'new' })}>
          <span>
            <Plus size={26} />
          </span>
          <strong>Create a new format</strong>
          <p>
            A different look for a different
            <br />
            kind of business.
          </p>
          <span className="fmt-new-card-link">
            Start designing
            <ArrowRight size={14} />
          </span>
        </button>
      </div>
      <div className="fmt-library-note">
        <ShieldCheck size={16} />
        <p>
          Formats belong to <strong>{organization.name}</strong>. Choose a saved format while creating an
          invoice or quotation.
        </p>
      </div>
    </div>
  );
}
