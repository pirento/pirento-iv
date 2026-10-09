import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  Layers3,
  LoaderCircle,
  Package,
  Palette,
  Plus,
  Save,
  Search,
  Trash2,
  Truck,
  Wrench,
} from 'lucide-react';
import {
  blankShipping,
  calculateLineAmount,
  calculateTotals,
  CATALOG_UNITS,
  defaultDocumentBranding,
  defaultFormatFor,
  DOCUMENT_LABELS,
  money,
  paidAmount,
  STATES,
  STATUS_LABELS,
} from '../../../shared/types';
import type {
  BillingProfile,
  BusinessDocument,
  BusinessProduct,
  CatalogItem,
  Customer,
  DocumentBranding,
  DocumentInput,
  DocumentKind,
  DocumentStatus,
  InvoiceFormat,
  LineItem,
  Organization,
  PricingDetails,
  ShippingDetails,
} from '../../../shared/types';
import { BILLING_PROFILES, billingProfileFor, emptyJewelleryPricing } from '../../../shared/billing-presets';
import {
  CONTACT_ROLE_LABELS,
  contactRoles,
  isInvoiceRecipient,
  type ContactRole,
} from '../../../shared/contact-types';
import { organizationForRegistration } from '../../../shared/business-identity';
import BrandImageUpload from '../../shared/ui/BrandImageUpload';
import PricingFields, { validatePricing } from '../catalog/PricingFields';
import './documents.css';
import './catalog-picker.css';

interface Props {
  organization: Organization;
  customers: Customer[];
  kind: DocumentKind;
  document?: BusinessDocument;
  initialDraft?: DocumentInput;
  catalog?: CatalogItem[];
  formats?: InvoiceFormat[];
  businessProducts?: BusinessProduct[];
  onSave: (input: DocumentInput, id?: string) => Promise<void>;
  onClose: () => void;
  onAddCustomer: (draft?: DocumentInput) => void;
  onManageCatalog?: (draft?: DocumentInput) => void;
  onManageFormats?: (draft?: DocumentInput) => void;
  onDraftChange?: (draft: DocumentInput) => void;
}

function indiaDate(offset = 0) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const blankItem = (profile: BillingProfile, delivery = false): LineItem => ({
  description: '',
  hsn: '',
  quantity: 1,
  rate: 0,
  gstRate: 0,
  unit: BILLING_PROFILES[profile].units[0],
  ...(!delivery && profile === 'jewellery'
    ? { pricing: emptyJewelleryPricing() }
    : !delivery && ['facility', 'elevator', 'ecosystem'].includes(profile)
      ? { pricing: { mode: 'recurring' as const, periods: 1, periodUnit: 'Month' as const } }
      : {}),
});

export default function DocumentEditor({
  organization,
  customers,
  kind,
  document: existing,
  initialDraft,
  catalog = [],
  formats = [],
  businessProducts = [],
  onSave,
  onClose,
  onAddCustomer,
  onManageCatalog,
  onManageFormats,
  onDraftChange,
}: Props) {
  const isDelivery = kind === 'delivery_note';
  const profile = billingProfileFor(organization);
  const finalized = Boolean(existing?.finalizedAt);
  const hasPayments = Boolean(existing && kind === 'invoice' && paidAmount(existing) > 0);
  const locked = finalized || hasPayments || Boolean(existing && existing.status !== 'draft');
  const divisionFormats = formats.filter((format) => format.organizationId === organization.id);
  const [form, setForm] = useState<DocumentInput>(() => ({
    customerId: existing?.customerId ?? '',
    status: existing?.status ?? 'draft',
    issueDate: existing?.issueDate ?? indiaDate(),
    dueDate: existing?.dueDate ?? (isDelivery ? '' : indiaDate(30)),
    title: existing?.title ?? DOCUMENT_LABELS[kind],
    discountPercent: existing?.discountPercent ?? 0,
    placeOfSupply: existing?.placeOfSupply ?? '',
    notes: existing?.notes ?? '',
    terms: existing?.terms ?? (isDelivery ? '' : organization.terms),
    formatId: existing
      ? existing.formatId
      : (divisionFormats.find((format) => format.isDefault) ?? divisionFormats[0])?.id,
    businessProductId: existing?.businessProductId,
    gstRegistrationId: existing?.gstRegistrationId,
    branding: existing?.branding ? { ...existing.branding } : undefined,
    installmentPlan: existing?.installmentPlan
      ? {
          ...existing.installmentPlan,
          installments: existing.installmentPlan.installments.map((item) => ({ ...item })),
        }
      : existing?.installmentPlan,
    ...initialDraft,
    organizationId: organization.id,
    kind,
    items: (initialDraft?.items ?? existing?.items)?.map((item) => structuredClone(item)) ?? [
      blankItem(profile, isDelivery),
    ],
    shipping: { ...blankShipping(), ...existing?.shipping, ...initialDraft?.shipping },
  }));
  const availableCustomers = customers.filter(
    (customer) =>
      customer.organizationId === organization.id &&
      (isInvoiceRecipient(customer) || customer.id === existing?.customerId),
  );
  function chooseCustomer(customerId: string) {
    const customer = availableCustomers.find((value) => value.id === customerId);
    setForm((current) => {
      let dueDate = current.dueDate;
      if (!existing && !isDelivery && customer?.paymentTermsDays) {
        const due = new Date(`${current.issueDate}T12:00:00Z`);
        due.setUTCDate(due.getUTCDate() + customer.paymentTermsDays);
        dueDate = due.toISOString().slice(0, 10);
      }
      const shipping = { ...blankShipping(), ...current.shipping };
      const previousCustomer = availableCustomers.find((value) => value.id === current.customerId);
      const previousShipping = previousCustomer && {
        recipientName: previousCustomer.name,
        address: previousCustomer.shippingAddress || previousCustomer.address,
        stateCode: previousCustomer.shippingStateCode || previousCustomer.stateCode,
        phone: previousCustomer.phone,
      };
      const inheritedShipping =
        previousShipping &&
        Object.entries(previousShipping).every(
          ([key, value]) => shipping[key as keyof ShippingDetails] === value,
        );
      if (customer && (!shipping.address || inheritedShipping)) {
        shipping.recipientName = customer.name;
        shipping.address = customer.shippingAddress || customer.address;
        shipping.stateCode = customer.shippingStateCode || customer.stateCode;
        shipping.phone = customer.phone;
      }
      return {
        ...current,
        customerId,
        dueDate,
        shipping,
        placeOfSupply: customer?.stateCode || current.placeOfSupply,
      };
    });
    setErrors((current) => ({ ...current, customerId: '', placeOfSupply: '' }));
  }
  const financialChange = Boolean(
    existing &&
    ((
      ['customerId', 'issueDate', 'items', 'discountPercent', 'placeOfSupply', 'businessProductId'] as const
    ).some((key) => JSON.stringify(form[key]) !== JSON.stringify(existing[key])) ||
      (form.gstRegistrationId || '') !== (existing.gstRegistrationId || '')),
  );
  const registrations = organization.gstRegistrations ?? [];
  const registrationAvailable =
    !form.gstRegistrationId ||
    registrations.some((registration) => registration.id === form.gstRegistrationId);
  const seller =
    existing && (!financialChange || !registrationAvailable)
      ? existing.organizationSnapshot
      : registrationAvailable
        ? organizationForRegistration(organization, form.gstRegistrationId)
        : organization;
  const [search, setSearch] = useState('');
  const [contactRole, setContactRole] = useState<'all' | ContactRole>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogType, setCatalogType] = useState<'all' | 'product' | 'service'>('all');
  const [catalogFeedback, setCatalogFeedback] = useState('');
  const [shippingExpanded, setShippingExpanded] = useState(
    isDelivery || Object.values(form.shipping ?? {}).some(Boolean),
  );
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [busyUploads, setBusyUploads] = useState<Record<string, boolean>>({});
  const uploadsRef = useRef<Record<string, boolean>>({});
  const uploadBusy = Object.values(busyUploads).some(Boolean);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const brandingRef = useRef<HTMLDetailsElement>(null);
  const draftChangeRef = useRef(onDraftChange);
  draftChangeRef.current = onDraftChange;
  const label = DOCUMENT_LABELS[kind].toLowerCase();
  const selectedCustomer =
    existing && !financialChange
      ? existing.customerSnapshot
      : availableCustomers.find((customer) => customer.id === form.customerId);
  const filteredCustomers = availableCustomers.filter(
    (customer) =>
      (contactRole === 'all' || contactRoles(customer).includes(contactRole)) &&
      [
        customer.name,
        customer.contactPerson,
        customer.phone,
        customer.email,
        customer.gstin,
        customer.pan,
        customer.address,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const retainedCustomerOption =
    selectedCustomer && !filteredCustomers.some((customer) => customer.id === selectedCustomer.id)
      ? selectedCustomer
      : undefined;
  const totals =
    existing && !financialChange
      ? existing.totals
      : calculateTotals(
          form.items,
          form.discountPercent,
          Boolean(seller.stateCode && form.placeOfSupply && seller.stateCode !== form.placeOfSupply),
        );
  const hasTax = !isDelivery && form.items.some((item) => item.gstRate > 0);
  const shipping = form.shipping ?? blankShipping();
  const paymentStatus =
    kind === 'invoice' && (hasPayments || form.status === 'paid' || form.status === 'partially_paid');
  const statuses: DocumentStatus[] = isDelivery
    ? ['draft', 'dispatched', 'delivered', 'cancelled']
    : kind === 'invoice'
      ? ['draft', 'sent', 'cancelled']
      : ['draft', 'sent', 'accepted', 'declined', 'cancelled'];
  const availableStatuses = paymentStatus
    ? [form.status]
    : statuses.filter((status) => status !== 'draft' || !existing || existing.status === 'draft');
  const products = businessProducts.filter(
    (product) => product.organizationId === organization.id && product.active,
  );
  const productSelection = organization.enableProductSelection ?? profile === 'ecosystem';
  const productRequired = productSelection && products.length > 0 && (!existing || financialChange);
  const selectedProduct =
    form.businessProductId === existing?.businessProductId
      ? (existing?.businessProductSnapshot ??
        products.find((product) => product.id === form.businessProductId))
      : products.find((product) => product.id === form.businessProductId);
  const activeCatalog = catalog.filter(
    (item) =>
      item.organizationId === organization.id &&
      item.active &&
      (!item.businessProductId || item.businessProductId === form.businessProductId),
  );
  const matchingCatalog = activeCatalog.filter(
    (item) =>
      (catalogType === 'all' || item.type === catalogType) &&
      `${item.name} ${item.description} ${item.sku} ${item.hsn}`
        .toLowerCase()
        .includes(catalogSearch.trim().toLowerCase()),
  );
  const savedFormatSelected = Boolean(existing?.formatSnapshot && form.formatId === existing.formatId);
  const selectedFormat = savedFormatSelected
    ? existing!.formatSnapshot!
    : (divisionFormats.find((format) => format.id === form.formatId) ?? defaultFormatFor(seller));
  const missingSavedFormat =
    existing?.formatSnapshot &&
    existing.formatId &&
    !divisionFormats.some((format) => format.id === existing.formatId);
  const branding = {
    ...defaultDocumentBranding(existing?.organizationSnapshot ?? organization),
    ...form.branding,
  };
  const planTotal =
    form.installmentPlan?.installments.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) ?? 0;
  const planMismatch = Boolean(form.installmentPlan && planTotal !== Math.round(totals.total * 100));

  useEffect(() => {
    // A newly loaded default can initialize a fresh form without replacing a choice.
    if (!existing && !form.formatId && divisionFormats.length) {
      const defaultFormat = divisionFormats.find((format) => format.isDefault) ?? divisionFormats[0];
      setForm((current) => (current.formatId ? current : { ...current, formatId: defaultFormat.id }));
    }
  }, [existing, form.formatId, formats, organization.id]);

  useEffect(() => {
    draftChangeRef.current?.(form);
  }, [form]);

  function update<K extends keyof DocumentInput>(key: K, value: DocumentInput[K]) {
    if (finalized) return;
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: '' }));
    setServerError('');
  }

  function updateItem(index: number, key: keyof LineItem, value: string | number) {
    if (locked) return;
    update(
      'items',
      form.items.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
    );
  }

  function updateShipping(key: keyof ShippingDetails, value: string) {
    update('shipping', { ...shipping, [key]: value });
  }

  function updatePricing(index: number, pricing?: PricingDetails) {
    if (locked || isDelivery) return;
    update(
      'items',
      form.items.map((item, i) =>
        i === index
          ? { ...item, pricing, ...(pricing?.mode === 'jewellery' ? { unit: 'Piece' } : {}) }
          : item,
      ),
    );
  }

  function updateBranding<K extends keyof DocumentBranding>(key: K, value: DocumentBranding[K]) {
    if (locked) return;
    setForm((current) => ({
      ...current,
      branding: {
        ...defaultDocumentBranding(existing?.organizationSnapshot ?? organization),
        ...current.branding,
        [key]: value,
      },
    }));
    setErrors((current) => ({ ...current, branding: '' }));
    setServerError('');
  }

  function setUploadBusy(key: string, busy: boolean) {
    uploadsRef.current = { ...uploadsRef.current, [key]: busy };
    setBusyUploads(uploadsRef.current);
  }

  function incompatibleLines(productId: string) {
    return form.items.filter((line) => {
      if (!line.catalogItemId) return false;
      const source = catalog.find((item) => item.id === line.catalogItemId);
      return source
        ? Boolean(source.businessProductId && source.businessProductId !== productId)
        : Boolean(form.businessProductId && form.businessProductId !== productId);
    });
  }

  function chooseProduct(productId: string) {
    if (locked) return;
    if (incompatibleLines(productId).length) {
      setPendingProductId(productId);
      return;
    }
    update('businessProductId', productId || undefined);
    setPendingProductId(null);
  }

  function confirmProductChange() {
    if (locked || pendingProductId === null) return;
    const incompatible = new Set(incompatibleLines(pendingProductId));
    const items = form.items.filter((item) => !incompatible.has(item));
    setForm((current) => ({
      ...current,
      businessProductId: pendingProductId || undefined,
      items: items.length ? items : [blankItem(profile, isDelivery)],
    }));
    setPendingProductId(null);
    setErrors((current) => ({ ...current, businessProductId: '', items: '' }));
    setCatalogFeedback('Product changed. Incompatible catalog lines were removed as requested.');
    setServerError('');
  }

  function addCatalogItem(item: CatalogItem) {
    if (locked || saving || form.items.length >= 200) return;
    const line: LineItem = {
      description: [item.name, item.description].filter(Boolean).join('\n'),
      hsn: item.hsn,
      quantity: 1,
      rate: isDelivery ? 0 : item.rate,
      gstRate: isDelivery ? 0 : item.gstRate,
      unit: item.unit,
      catalogItemId: item.id,
      itemType: item.type,
      ...(!isDelivery && item.pricing ? { pricing: structuredClone(item.pricing) } : {}),
    };
    const first = form.items[0];
    const empty = blankItem(profile, isDelivery);
    const blank =
      form.items.length === 1 &&
      !first.description.trim() &&
      !first.hsn.trim() &&
      !first.rate &&
      first.quantity === 1 &&
      !first.gstRate &&
      (!first.unit?.trim() || first.unit === empty.unit) &&
      JSON.stringify(first.pricing) === JSON.stringify(empty.pricing) &&
      !first.catalogItemId;
    update('items', blank ? [line] : [...form.items, line]);
    setCatalogFeedback(
      `${item.name} added to this document. You can edit its ${isDelivery ? 'quantity and details' : 'quantity and rate'} below.`,
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current || finalized || Object.values(uploadsRef.current).some(Boolean)) return;
    const next: Record<string, string> = {};
    if (!form.customerId)
      next.customerId = 'Choose a saved customer, B2B buyer or vendor to save this document.';
    if (!registrationAvailable && (!existing || financialChange))
      next.gstRegistrationId =
        'This saved GST registration is no longer available. Choose a current seller GST registration.';
    if (!form.title.trim()) next.title = 'Add a title for this document.';
    if (!form.issueDate) next.issueDate = 'Choose an issue date.';
    if (form.dueDate && form.dueDate < form.issueDate)
      next.dueDate = 'Choose a date on or after the issue date.';
    if (
      form.items.some(
        (item) =>
          !item.description.trim() ||
          !Number.isFinite(item.quantity) ||
          item.quantity <= 0 ||
          (!isDelivery &&
            (!Number.isFinite(item.rate) ||
              item.rate < 0 ||
              !Number.isFinite(item.gstRate) ||
              item.gstRate < 0 ||
              item.gstRate > 40)),
      )
    )
      next.items = isDelivery
        ? 'Each item needs a description and a quantity above zero.'
        : 'Each item needs a description, quantity above zero, a non-negative rate and GST between 0% and 40%.';
    if (form.items.some((item) => item.hsn.trim() && !/^\d{4,8}$/.test(item.hsn.trim())))
      next.items = 'HSN / SAC codes must contain 4–8 digits, or can be left blank.';
    if (
      !isDelivery &&
      (!Number.isFinite(form.discountPercent) || form.discountPercent < 0 || form.discountPercent > 100)
    )
      next.discountPercent = 'Enter a discount between 0% and 100%.';
    if (hasTax && !form.placeOfSupply)
      next.placeOfSupply = 'Choose the place of supply to calculate CGST/SGST or IGST.';
    if (hasTax && (!seller.gstin || !seller.stateCode))
      next.gstRegistrationId =
        'Choose a registered seller GSTIN, or add the GSTIN and state in organization settings before charging GST.';
    if (shipping.dispatchDate && shipping.deliveryDate && shipping.deliveryDate < shipping.dispatchDate)
      next.shipping = 'Delivery date must be on or after the dispatch date.';
    if (productRequired && !form.businessProductId)
      next.businessProductId = 'Choose the business product this document is for.';
    if (pendingProductId !== null)
      next.businessProductId = 'Confirm or cancel the pending product change before saving.';
    if (!isDelivery) {
      for (const [index, item] of form.items.entries()) {
        const pricingError = validatePricing(item.pricing);
        if (pricingError) next.items = `Item ${index + 1}: ${pricingError}`;
        if (item.pricing?.mode === 'jewellery' && !Number.isInteger(item.quantity))
          next.items = `Item ${index + 1}: jewellery quantity must be a whole number of pieces.`;
      }
      if (totals.subtotal > 1000000000) next.items = 'Document subtotal cannot exceed ₹100 crore.';
    }
    if (form.branding?.logoMode === 'custom' && !form.branding.logoUrl)
      next.branding = 'Upload a custom logo, use the inherited logo or select no logo.';
    if (planMismatch)
      next.installmentPlan =
        'The installment plan no longer matches this total. Clear the plan before saving, then create a revised plan from Payments.';
    setErrors(next);
    if (Object.keys(next).length) {
      if (next.shipping) setShippingExpanded(true);
      if (next.branding && brandingRef.current) brandingRef.current.open = true;
      setServerError('Please complete the highlighted fields.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setServerError('');
    try {
      await onSave(
        {
          ...form,
          title: form.title.trim(),
          discountPercent: isDelivery ? 0 : form.discountPercent,
          items: form.items.map((item) => ({
            ...item,
            description: item.description.trim(),
            hsn: item.hsn.trim(),
            unit: item.unit?.trim(),
            ...(isDelivery ? { rate: 0, gstRate: 0, pricing: undefined } : {}),
          })),
        },
        existing?.id,
      );
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : 'Could not save this document. Please try again.',
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const errorFor = (name: string) =>
    errors[name] ? (
      <span className="doc-field-error" role="alert">
        {errors[name]}
      </span>
    ) : null;

  return (
    <section className="workspace-page doc-editor-page doc-editor" aria-labelledby="doc-editor-heading">
      <header className="doc-page-header">
        <div className="doc-page-heading">
          <span className="doc-heading-icon">
            <FileText size={21} />
          </span>
          <div>
            <h1 id="doc-editor-heading">
              {finalized ? 'View' : existing ? 'Edit' : 'Create'} {label}
            </h1>
            <p>
              {organization.name} <span>·</span> {existing?.number ?? 'Number assigned when saved'}
            </p>
          </div>
        </div>
        <button
          className="doc-button doc-button-secondary doc-page-back"
          type="button"
          onClick={onClose}
          disabled={saving || uploadBusy}
        >
          <ArrowLeft size={16} /> Back
        </button>
      </header>
      <form onSubmit={submit} noValidate>
        <fieldset className="doc-content-fieldset" disabled={saving || finalized}>
          <div className="doc-editor-content">
            {finalized ? (
              <p className="doc-tax-note doc-finalized-note">
                <Check size={16} /> This invoice is finalized. All document details are locked. View its
                payment history from the invoice preview.
              </p>
            ) : (
              locked && (
                <p className="doc-tax-note">
                  {hasPayments
                    ? 'Payments have been recorded against this invoice.'
                    : 'This document has been issued.'}{' '}
                  Customer, issue date, line items and tax details are locked. You can update its format,{' '}
                  {hasPayments ? '' : 'status, '}shipping details, due date, title, notes and terms.
                </p>
              )
            )}
            {isDelivery && (
              <p className="doc-delivery-note">
                <Truck size={16} /> Delivery challans record items, quantities and shipping details. Prices
                and taxes are not included.
              </p>
            )}
            {(productSelection || form.businessProductId) && (
              <section className="doc-business-product-picker" aria-label="Business product">
                <div>
                  <Layers3 size={19} />
                  <span>
                    <strong>{DOCUMENT_LABELS[kind]} for a business product</strong>
                    <small>{organization.name} · one product per document</small>
                  </span>
                </div>
                <label className="doc-field">
                  Business product{productRequired ? ' *' : ''}
                  <select
                    disabled={locked}
                    value={form.businessProductId ?? ''}
                    aria-invalid={!!errors.businessProductId}
                    onChange={(event) => chooseProduct(event.target.value)}
                  >
                    <option value="">Select business product</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                    {existing?.businessProductId &&
                      !products.some((product) => product.id === existing.businessProductId) && (
                        <option value={existing.businessProductId}>
                          {existing.businessProductSnapshot?.name ?? 'Saved business product'} · Saved
                          selection
                        </option>
                      )}
                  </select>
                  {errorFor('businessProductId')}
                </label>
                <p className="doc-help">
                  {selectedProduct?.description ||
                    'The catalog shows this product’s items plus shared organization services. Customer and company billing details remain on this document.'}
                </p>
                {pendingProductId !== null && (
                  <div className="doc-product-change-confirm" role="alert">
                    <strong>Some line items belong to another product.</strong>
                    <p>
                      Switching to{' '}
                      {products.find((product) => product.id === pendingProductId)?.name ?? 'no product'} will
                      remove {incompatibleLines(pendingProductId).length} incompatible catalog{' '}
                      {incompatibleLines(pendingProductId).length === 1 ? 'line' : 'lines'}. Your other lines
                      will stay.
                    </p>
                    <div>
                      <button
                        type="button"
                        className="doc-button doc-button-secondary"
                        onClick={() => setPendingProductId(null)}
                      >
                        Keep current product
                      </button>
                      <button
                        type="button"
                        className="doc-button doc-button-primary"
                        onClick={confirmProductChange}
                      >
                        Switch and remove lines
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            <section className="doc-seller-registration" aria-label="Seller identity and GST">
              <div className="doc-seller-identity">
                <span className="doc-seller-caption">SELLER / BUSINESS</span>
                <strong>{seller.legalName || seller.name}</strong>
                {seller.name !== seller.legalName && <span>{seller.name}</span>}
                <p>{seller.address || 'Add the seller’s billing address in organization settings.'}</p>
                <small>
                  {seller.gstin ? `GSTIN: ${seller.gstin}` : 'No GST registration selected'}
                  {seller.stateCode
                    ? ` · ${STATES.find(([code]) => code === seller.stateCode)?.[1] ?? seller.stateCode}`
                    : ''}
                </small>
              </div>
              <div>
                <label className="doc-field">
                  Seller GST registration
                  <select
                    aria-label="Seller GST registration"
                    disabled={locked}
                    value={form.gstRegistrationId ?? ''}
                    aria-invalid={!!errors.gstRegistrationId}
                    onChange={(event) => update('gstRegistrationId', event.target.value)}
                  >
                    <option value="">
                      Default{organization.gstin ? ` · ${organization.gstin}` : ' · GSTIN not set'}
                    </option>
                    {registrations.map((registration) => (
                      <option key={registration.id} value={registration.id}>
                        {registration.label} · {registration.gstin}
                      </option>
                    ))}
                    {form.gstRegistrationId && !registrationAvailable && (
                      <option value={form.gstRegistrationId}>
                        Saved registration · {existing?.organizationSnapshot.gstin || 'Unavailable'}
                      </option>
                    )}
                  </select>
                  {errorFor('gstRegistrationId')}
                </label>
                <p className="doc-help">
                  {locked
                    ? 'The issued document keeps its saved seller, GSTIN and tax calculation.'
                    : 'Choose this organization’s billing registration. Its address and state determine CGST / SGST or IGST. Add or edit registrations in organization settings.'}
                </p>
              </div>
            </section>
            <section className="doc-section">
              <div className="doc-section-title">
                <span className="doc-step">01</span>
                <h3>Contact & document details</h3>
              </div>
              <div className="doc-details-grid">
                <div className="doc-customer-picker">
                  <div className="doc-label-row">
                    <label htmlFor="doc-customer">
                      {isDelivery ? 'Deliver to' : 'Bill to'} <span>*</span>
                    </label>
                    <button
                      type="button"
                      className="doc-text-button"
                      onClick={() => onAddCustomer(form)}
                      disabled={saving || uploadBusy || locked}
                    >
                      <Plus size={14} /> New contact
                    </button>
                  </div>
                  <p className="doc-contact-scope">Saved contacts in {organization.name}</p>
                  {availableCustomers.length > 0 ? (
                    <>
                      <div
                        className="doc-contact-role-filters"
                        role="group"
                        aria-label="Invoice contact roles"
                      >
                        {(
                          [
                            ['all', 'All'],
                            ['customer', 'Customers'],
                            ['b2b_buyer', 'B2B buyers'],
                            ['vendor', 'Vendors'],
                          ] as const
                        ).map(([role, roleLabel]) => (
                          <button
                            key={role}
                            type="button"
                            disabled={locked}
                            aria-pressed={contactRole === role}
                            onClick={() => setContactRole(role)}
                          >
                            {roleLabel}
                          </button>
                        ))}
                      </div>
                      <div className="doc-search">
                        <Search size={16} />
                        <input
                          disabled={locked}
                          aria-label="Search saved contacts"
                          placeholder="Name, contact person, phone, email, GSTIN or PAN"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                      <select
                        disabled={locked}
                        id="doc-customer"
                        value={form.customerId}
                        aria-invalid={!!errors.customerId}
                        onChange={(event) => chooseCustomer(event.target.value)}
                      >
                        <option value="">Select a saved contact</option>
                        {retainedCustomerOption && (
                          <option value={retainedCustomerOption.id}>
                            {retainedCustomerOption.name} · Selected
                          </option>
                        )}
                        {filteredCustomers.map((customer) => (
                          <option value={customer.id} key={customer.id}>
                            {customer.name} ·{' '}
                            {contactRoles(customer)
                              .map((role) => CONTACT_ROLE_LABELS[role])
                              .join(' / ')}
                            {customer.gstin ? ` · ${customer.gstin}` : ''}
                            {customer.active === false ? ' · Archived' : ''}
                          </option>
                        ))}
                      </select>
                      {filteredCustomers.length === 0 && (
                        <small className="doc-help">
                          No matching contacts in this organization. Try another search or contact role.
                        </small>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="doc-empty-customer"
                      onClick={() => onAddCustomer(form)}
                      disabled={locked || uploadBusy}
                    >
                      <Plus size={20} />
                      <strong>Add your first contact</strong>
                      <span>Save a customer, B2B buyer or vendor for future documents</span>
                    </button>
                  )}
                  {errorFor('customerId')}
                  {selectedCustomer && (
                    <div className="doc-customer-card">
                      <span className="doc-customer-check">
                        <Check size={14} />
                      </span>
                      <div>
                        <strong>{selectedCustomer.name}</strong>
                        <small>
                          {contactRoles(selectedCustomer)
                            .map((role) => CONTACT_ROLE_LABELS[role])
                            .join(' · ')}
                        </small>
                        {selectedCustomer.address && <p>{selectedCustomer.address}</p>}
                        <small>
                          {selectedCustomer.gstin ? `GSTIN: ${selectedCustomer.gstin}` : 'No GSTIN added'}
                          {selectedCustomer.email ? ` · ${selectedCustomer.email}` : ''}
                          {selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ''}
                        </small>
                      </div>
                    </div>
                  )}
                </div>
                <div className="doc-meta-fields">
                  <label className="doc-field doc-wide">
                    Document title *
                    <input
                      aria-invalid={!!errors.title}
                      placeholder="e.g. Monthly facility management"
                      value={form.title}
                      maxLength={200}
                      onChange={(event) => update('title', event.target.value)}
                    />
                    {errorFor('title')}
                  </label>
                  <label className="doc-field">
                    Issue date *
                    <input
                      disabled={locked}
                      type="date"
                      min="2000-01-01"
                      max="2199-12-31"
                      value={form.issueDate}
                      aria-invalid={!!errors.issueDate}
                      onChange={(event) => update('issueDate', event.target.value)}
                    />
                    {errorFor('issueDate')}
                  </label>
                  {!isDelivery && (
                    <label className="doc-field">
                      {kind === 'invoice' ? 'Due date' : 'Valid until'}
                      <input
                        type="date"
                        min={form.issueDate || '2000-01-01'}
                        max="2199-12-31"
                        value={form.dueDate}
                        aria-invalid={!!errors.dueDate}
                        onChange={(event) => update('dueDate', event.target.value)}
                      />
                      {errorFor('dueDate')}
                    </label>
                  )}
                  <label className="doc-field">
                    Status
                    <select
                      aria-label="Status"
                      value={form.status}
                      disabled={paymentStatus}
                      onChange={(event) => update('status', event.target.value as DocumentStatus)}
                    >
                      {availableStatuses.map((status) => (
                        <option key={status} value={status}>
                          {STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                    {kind === 'invoice' && (
                      <small className="doc-help">
                        Record payments from the invoice preview to update payment status.
                      </small>
                    )}
                  </label>
                  {!isDelivery && (
                    <label className="doc-field">
                      Place of supply
                      <select
                        aria-label="Place of supply"
                        disabled={locked}
                        value={form.placeOfSupply}
                        aria-invalid={!!errors.placeOfSupply}
                        onChange={(event) => update('placeOfSupply', event.target.value)}
                      >
                        <option value="">Select state</option>
                        {STATES.map(([code, name]) => (
                          <option value={code} key={code}>
                            {name} ({code})
                          </option>
                        ))}
                      </select>
                      {errorFor('placeOfSupply')}
                    </label>
                  )}
                </div>
              </div>
            </section>
            <section className="doc-format-picker" aria-label="Document format">
              <div
                className={`doc-format-thumbnail doc-format-thumbnail-${selectedFormat.layout}`}
                style={{ '--format-accent': selectedFormat.accentColor } as React.CSSProperties}
                aria-hidden="true"
              >
                <div className="doc-format-mini-header">
                  <i />
                  <span>
                    <b />
                    <b />
                  </span>
                </div>
                <div className="doc-format-mini-parties">
                  <i />
                  <i />
                </div>
                <div className="doc-format-mini-table">
                  <b />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="doc-format-mini-total" />
                <div className="doc-format-mini-footer">
                  <i />
                  <i />
                </div>
              </div>
              <div className="doc-format-picker-content">
                <div className="doc-label-row">
                  <label htmlFor="doc-format">
                    <Palette size={14} /> Document format
                  </label>
                  {onManageFormats && (
                    <button
                      type="button"
                      className="doc-text-button"
                      disabled={uploadBusy}
                      onClick={() => onManageFormats?.(form)}
                    >
                      <Plus size={14} /> Create a format
                    </button>
                  )}
                </div>
                <select
                  id="doc-format"
                  value={form.formatId ?? ''}
                  onChange={(event) => update('formatId', event.target.value || undefined)}
                >
                  {(!divisionFormats.length || !form.formatId || (existing && !existing.formatId)) && (
                    <option value="">{existing ? 'Original division format' : 'Division default'}</option>
                  )}
                  {divisionFormats.map((format) => (
                    <option key={format.id} value={format.id}>
                      {format.name}
                      {format.isDefault ? ' · Default' : ''}
                      {existing?.formatSnapshot && format.id === existing.formatId ? ' · Saved version' : ''}
                    </option>
                  ))}
                  {missingSavedFormat && (
                    <option value={existing.formatId}>{existing.formatSnapshot!.name} · Saved version</option>
                  )}
                </select>
                <div className="doc-format-features">
                  <span>{selectedFormat.layout} layout</span>
                  <span>{selectedFormat.density} spacing</span>
                  <span>
                    {selectedFormat.pageSize ?? 'A4'} · {selectedFormat.orientation ?? 'portrait'}
                  </span>
                  {!isDelivery && selectedFormat.showBankDetails && <span>Bank details</span>}
                  {selectedFormat.showSignature && <span>Signature</span>}
                </div>
                <p className="doc-help">
                  {finalized
                    ? 'The saved format is locked with this finalized invoice.'
                    : savedFormatSelected
                      ? 'This document keeps its saved format. Choose another format to change its appearance.'
                      : 'This format is used for preview, print and PDF download.'}
                </p>
              </div>
            </section>
            <details className="doc-branding-panel" ref={brandingRef}>
              <summary>
                <Palette size={16} />
                <span>
                  <strong>Document logo, signatures & stamp</strong>
                  <small>
                    {locked ? 'Saved branding · locked after issue' : 'Customize this document’s branding'}
                  </small>
                </span>
                <ChevronDown size={15} />
              </summary>
              <fieldset className="doc-branding-fields" disabled={locked || uploadBusy}>
                <p className="doc-help">
                  {locked
                    ? 'Branding is saved with this document and can only be changed while it is a draft.'
                    : 'These settings apply to this draft. They use this organization’s branding and the selected format.'}
                </p>
                <div className="doc-branding-logo-controls">
                  <label className="doc-field">
                    Document logo
                    <select
                      value={branding.logoMode}
                      onChange={(event) =>
                        updateBranding('logoMode', event.target.value as DocumentBranding['logoMode'])
                      }
                    >
                      <option value="inherit">Use saved format / organization logo</option>
                      <option value="custom">Use a custom logo for this document</option>
                      <option value="none">No logo</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="doc-button doc-button-secondary"
                    disabled={!organization.logoUrl}
                    onClick={() => {
                      updateBranding('logoMode', 'custom');
                      updateBranding('logoUrl', organization.logoUrl);
                    }}
                  >
                    Copy current organization logo
                  </button>
                </div>
                {branding.logoMode === 'custom' && (
                  <BrandImageUpload
                    label="Document logo"
                    value={branding.logoUrl}
                    onChange={(value) => updateBranding('logoUrl', value)}
                    disabled={locked || uploadBusy}
                    onBusyChange={(busy) => setUploadBusy('logo', busy)}
                  />
                )}
                {branding.logoMode === 'inherit' && (selectedFormat.logoUrl || seller.logoUrl) && (
                  <div className="doc-inherited-logo">
                    <img src={selectedFormat.logoUrl || seller.logoUrl} alt="Inherited document logo" />
                    <span>Inherited from the saved format or organization details.</span>
                  </div>
                )}
                {errorFor('branding')}
                <div className="doc-branding-image-grid">
                  <section>
                    <h4>Primary signature</h4>
                    <label className="doc-field">
                      Primary signature caption
                      <input
                        value={branding.primarySignatureLabel}
                        maxLength={200}
                        placeholder="Authorised Signatory"
                        onChange={(event) => updateBranding('primarySignatureLabel', event.target.value)}
                      />
                    </label>
                    <BrandImageUpload
                      label="Primary Signature"
                      value={branding.primarySignatureImageUrl}
                      onChange={(value) => updateBranding('primarySignatureImageUrl', value)}
                      disabled={locked || uploadBusy}
                      onBusyChange={(busy) => setUploadBusy('primary', busy)}
                    />
                  </section>
                  <section>
                    <label className="doc-branding-toggle">
                      <input
                        type="checkbox"
                        checked={branding.showSecondarySignature}
                        onChange={(event) => updateBranding('showSecondarySignature', event.target.checked)}
                      />
                      <span>Secondary signature</span>
                    </label>
                    {branding.showSecondarySignature && (
                      <>
                        <label className="doc-field">
                          Secondary signature caption
                          <input
                            value={branding.secondarySignatureLabel}
                            maxLength={200}
                            placeholder="Second authorised signatory"
                            onChange={(event) =>
                              updateBranding('secondarySignatureLabel', event.target.value)
                            }
                          />
                        </label>
                        <BrandImageUpload
                          label="Secondary Signature"
                          value={branding.secondarySignatureImageUrl}
                          onChange={(value) => updateBranding('secondarySignatureImageUrl', value)}
                          disabled={locked || uploadBusy}
                          onBusyChange={(busy) => setUploadBusy('secondary', busy)}
                        />
                      </>
                    )}
                  </section>
                  <section>
                    <label className="doc-branding-toggle">
                      <input
                        type="checkbox"
                        checked={branding.showStamp}
                        onChange={(event) => updateBranding('showStamp', event.target.checked)}
                      />
                      <span>Company stamp</span>
                    </label>
                    {branding.showStamp && (
                      <>
                        <label className="doc-field">
                          Stamp caption
                          <input
                            value={branding.stampLabel}
                            maxLength={200}
                            placeholder="Company stamp"
                            onChange={(event) => updateBranding('stampLabel', event.target.value)}
                          />
                        </label>
                        <BrandImageUpload
                          label="Company stamp"
                          value={branding.stampImageUrl}
                          onChange={(value) => updateBranding('stampImageUrl', value)}
                          disabled={locked || uploadBusy}
                          onBusyChange={(busy) => setUploadBusy('stamp', busy)}
                        />
                      </>
                    )}
                  </section>
                </div>
                <p className="doc-help">
                  The selected format’s display controls also apply to signatures and stamps in the preview
                  and PDF.
                </p>
              </fieldset>
              {uploadBusy && (
                <p className="doc-branding-upload-status" role="status">
                  <LoaderCircle size={14} className="doc-spinning" /> Reading image. Save will be available
                  when it finishes.
                </p>
              )}
            </details>
            <section className="doc-section">
              <div className="doc-section-title">
                <span className="doc-step">02</span>
                <h3>Items & services</h3>
                <span className="doc-section-hint">
                  {isDelivery ? 'Quantities and units' : 'All amounts in INR'}
                </span>
              </div>
              {!isDelivery && (
                <p className="doc-billing-profile-hint">
                  <strong>{BILLING_PROFILES[profile].label}</strong>
                  <span>
                    {BILLING_PROFILES[profile].hint}. Expand an item’s pricing method to adjust its
                    calculation.
                  </span>
                </p>
              )}
              {!locked && (
                <div className="doc-catalog-picker">
                  <div className="doc-catalog-heading">
                    <div>
                      <Layers3 size={16} />
                      <strong>Add from {organization.name}</strong>
                      <span>
                        {activeCatalog.length} active {activeCatalog.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                    {onManageCatalog && (
                      <button
                        type="button"
                        className="doc-text-button"
                        disabled={uploadBusy}
                        onClick={() => onManageCatalog?.(form)}
                      >
                        Manage catalog <ArrowRight size={13} />
                      </button>
                    )}
                  </div>
                  {activeCatalog.length > 0 ? (
                    <>
                      <div className="doc-catalog-controls">
                        <div className="doc-search">
                          <Search size={15} />
                          <input
                            aria-label="Search products and services"
                            placeholder="Search products, services, SKU or HSN"
                            value={catalogSearch}
                            onChange={(event) => setCatalogSearch(event.target.value)}
                          />
                        </div>
                        <div className="doc-catalog-filters" role="group" aria-label="Catalog item type">
                          {(['all', 'service', 'product'] as const).map((type) => (
                            <button
                              key={type}
                              type="button"
                              aria-pressed={catalogType === type}
                              onClick={() => setCatalogType(type)}
                            >
                              {type === 'all' ? 'All' : type === 'service' ? 'Services' : 'Products'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="doc-catalog-results" aria-label="Available catalog items">
                        {matchingCatalog.map((item) => (
                          <button
                            type="button"
                            className="doc-catalog-result"
                            key={item.id}
                            onClick={() => addCatalogItem(item)}
                            disabled={form.items.length >= 200}
                            aria-label={`Add ${item.name} to document`}
                          >
                            <span className={`doc-catalog-type-icon doc-catalog-type-${item.type}`}>
                              {item.type === 'product' ? <Package size={16} /> : <Wrench size={16} />}
                            </span>
                            <span className="doc-catalog-result-info">
                              <strong>{item.name}</strong>
                              <small>
                                {item.type === 'product' ? 'Product' : 'Service'}
                                {item.sku ? ` · ${item.sku}` : ''}
                                {item.hsn ? ` · HSN/SAC ${item.hsn}` : ''}
                              </small>
                            </span>
                            <span className="doc-catalog-result-price">
                              {isDelivery ? (
                                <strong>{item.unit || 'Unit'}</strong>
                              ) : (
                                <>
                                  <strong>
                                    {money(item.rate)}
                                    {item.unit && <small> / {item.unit}</small>}
                                  </strong>
                                  <small>{item.gstRate}% GST</small>
                                </>
                              )}
                            </span>
                            <Plus size={15} />
                          </button>
                        ))}
                        {matchingCatalog.length === 0 && (
                          <p className="doc-catalog-empty">
                            No matching {catalogType === 'all' ? 'products or services' : `${catalogType}s`}.
                            Try another search or add a manual line below.
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="doc-catalog-empty">
                      Add products and services to this organization’s catalog to reuse their{' '}
                      {isDelivery ? 'descriptions and units' : 'prices and tax details'}. You can also enter a
                      line manually below.
                    </p>
                  )}
                  <p className="doc-catalog-feedback" role="status">
                    {catalogFeedback ||
                      (isDelivery
                        ? 'Catalog descriptions and units are copied into this challan. Edit the quantities below.'
                        : 'Catalog items are copied into this document. Edit their quantity, price and details below.')}
                  </p>
                </div>
              )}
              <datalist id="doc-unit-options">
                {[...new Set([...BILLING_PROFILES[profile].units, ...CATALOG_UNITS])].map((unit) => (
                  <option key={unit} value={unit} />
                ))}
              </datalist>
              <div className="doc-items-scroll">
                <table
                  className={`doc-items-table doc-items-with-units${isDelivery ? ' doc-quantity-items' : ''}`}
                >
                  <thead>
                    <tr>
                      <th>Item / service</th>
                      <th>HSN / SAC</th>
                      <th>Qty</th>
                      <th>Unit</th>
                      {!isDelivery && (
                        <>
                          <th>Rate (₹)</th>
                          <th>GST %</th>
                          <th className="doc-align-right">Amount</th>
                        </>
                      )}
                      <th>
                        <span className="doc-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((item, index) => (
                      <Fragment key={index}>
                        <tr>
                          <td>
                            <textarea
                              disabled={locked}
                              aria-label={`Item ${index + 1} description`}
                              rows={2}
                              placeholder="Describe your product or service"
                              value={item.description}
                              maxLength={2500}
                              onChange={(event) => updateItem(index, 'description', event.target.value)}
                            />
                            {item.catalogItemId && (
                              <small className="doc-line-source">
                                {item.itemType === 'product' ? <Package size={10} /> : <Wrench size={10} />}
                                {item.itemType === 'product' ? 'Product' : 'Service'} · copied from catalog
                              </small>
                            )}
                          </td>
                          <td>
                            <input
                              disabled={locked}
                              aria-label={`Item ${index + 1} HSN or SAC`}
                              placeholder="Optional"
                              value={item.hsn}
                              maxLength={8}
                              onChange={(event) => updateItem(index, 'hsn', event.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              disabled={locked}
                              aria-label={`Item ${index + 1} quantity`}
                              type="number"
                              min={item.pricing?.mode === 'jewellery' ? 1 : 0.001}
                              max="1000000"
                              step={item.pricing?.mode === 'jewellery' ? 1 : 'any'}
                              value={item.quantity}
                              onChange={(event) => updateItem(index, 'quantity', Number(event.target.value))}
                            />
                          </td>
                          <td>
                            <input
                              disabled={locked}
                              aria-label={`Item ${index + 1} unit`}
                              list="doc-unit-options"
                              placeholder="e.g. Hour"
                              value={item.unit ?? ''}
                              maxLength={20}
                              onChange={(event) => updateItem(index, 'unit', event.target.value)}
                            />
                          </td>
                          {!isDelivery && (
                            <>
                              <td>
                                <input
                                  disabled={locked}
                                  aria-label={`Item ${index + 1} rate`}
                                  type="number"
                                  min="0"
                                  max="100000000"
                                  step="0.01"
                                  value={item.rate}
                                  onChange={(event) => updateItem(index, 'rate', Number(event.target.value))}
                                />
                                {item.pricing?.mode === 'jewellery' && (
                                  <small className="doc-line-source">₹ per gram</small>
                                )}
                                {item.pricing?.mode === 'recurring' && (
                                  <small className="doc-line-source">
                                    per {item.unit || 'unit'} /{' '}
                                    {(item.pricing.periodUnit || 'Month').toLowerCase()}
                                  </small>
                                )}
                              </td>
                              <td>
                                <input
                                  disabled={locked}
                                  aria-label={`Item ${index + 1} GST percent`}
                                  type="number"
                                  min="0"
                                  max="40"
                                  step="any"
                                  value={item.gstRate}
                                  onChange={(event) =>
                                    updateItem(index, 'gstRate', Number(event.target.value))
                                  }
                                />
                              </td>
                              <td className="doc-line-amount">{money(calculateLineAmount(item))}</td>
                            </>
                          )}
                          <td>
                            <button
                              type="button"
                              className="doc-icon-button doc-delete"
                              aria-label={`Remove item ${index + 1}`}
                              disabled={locked || form.items.length === 1}
                              onClick={() =>
                                update(
                                  'items',
                                  form.items.filter((_, i) => i !== index),
                                )
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                        {!isDelivery && (
                          <tr className="doc-line-pricing-row">
                            <td colSpan={8}>
                              <details
                                open={
                                  item.pricing?.mode === 'recurring' || item.pricing?.mode === 'jewellery'
                                }
                              >
                                <summary>
                                  {item.pricing?.mode === 'jewellery'
                                    ? 'Jewellery weight & charges'
                                    : item.pricing?.mode === 'recurring'
                                      ? 'Recurring billing periods'
                                      : 'Pricing method · standard'}
                                  <span>Item {index + 1}</span>
                                </summary>
                                <PricingFields
                                  value={item.pricing}
                                  onChange={(pricing) => updatePricing(index, pricing)}
                                  rate={item.rate}
                                  unit={item.unit}
                                  quantity={item.quantity}
                                  profile={profile}
                                  disabled={locked}
                                  idPrefix={`doc-item-${index}`}
                                />
                              </details>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {errorFor('items')}
              <button
                type="button"
                className="doc-add-item"
                disabled={locked || form.items.length >= 200}
                onClick={() => update('items', [...form.items, blankItem(profile, isDelivery)])}
              >
                <Plus size={16} /> Add line item
              </button>
              {hasTax && (!form.placeOfSupply || !seller.stateCode || !seller.gstin) && (
                <p className="doc-tax-note">
                  GST totals are a preview. Add the seller’s GST details and place of supply before saving
                  taxable items.
                </p>
              )}
            </section>
            <section className="doc-shipping-section" aria-label="Shipping and delivery">
              <div className="doc-shipping-heading">
                <button
                  type="button"
                  className="doc-shipping-toggle"
                  aria-expanded={shippingExpanded}
                  aria-controls="doc-shipping-fields"
                  onClick={() => setShippingExpanded((value) => !value)}
                >
                  <Truck size={17} />
                  <span>
                    <strong>Shipping & delivery</strong>
                    <small>Recipient, transport and delivery instructions</small>
                  </span>
                  <ChevronDown size={16} className={shippingExpanded ? 'doc-chevron-open' : ''} />
                </button>
                <span className="doc-shipping-optional">Optional</span>
              </div>
              {shippingExpanded && (
                <div id="doc-shipping-fields" className="doc-shipping-fields">
                  <div className="doc-shipping-recipient-heading">
                    <h4>Ship to</h4>
                    <button
                      type="button"
                      className="doc-text-button"
                      disabled={!selectedCustomer}
                      onClick={() =>
                        selectedCustomer &&
                        update('shipping', {
                          ...shipping,
                          recipientName: selectedCustomer.name,
                          address: selectedCustomer.address,
                          stateCode: selectedCustomer.stateCode,
                          phone: selectedCustomer.phone,
                        })
                      }
                    >
                      Copy customer details
                    </button>
                  </div>
                  <div className="doc-shipping-grid">
                    <label className="doc-field">
                      Recipient name
                      <input
                        value={shipping.recipientName}
                        maxLength={200}
                        placeholder="Person or company receiving the delivery"
                        onChange={(event) => updateShipping('recipientName', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Recipient phone
                      <input
                        type="tel"
                        value={shipping.phone}
                        maxLength={30}
                        placeholder="Delivery contact number"
                        onChange={(event) => updateShipping('phone', event.target.value)}
                      />
                    </label>
                    <label className="doc-field doc-wide">
                      Shipping address
                      <textarea
                        rows={2}
                        value={shipping.address}
                        maxLength={2000}
                        placeholder="Street, building, city and PIN code"
                        onChange={(event) => updateShipping('address', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Shipping state
                      <select
                        value={shipping.stateCode}
                        onChange={(event) => updateShipping('stateCode', event.target.value)}
                      >
                        <option value="">Select state</option>
                        {STATES.map(([code, name]) => (
                          <option key={code} value={code}>
                            {name} ({code})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="doc-field">
                      Order / delivery reference
                      <input
                        value={shipping.reference}
                        maxLength={200}
                        placeholder="PO, order or dispatch reference"
                        onChange={(event) => updateShipping('reference', event.target.value)}
                      />
                    </label>
                  </div>
                  <h4 className="doc-shipping-transport-heading">Transport & tracking</h4>
                  <div className="doc-shipping-grid doc-shipping-transport-grid">
                    <label className="doc-field">
                      Carrier / transporter
                      <input
                        value={shipping.carrier}
                        maxLength={200}
                        placeholder="Courier or transport company"
                        onChange={(event) => updateShipping('carrier', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Tracking / LR number
                      <input
                        value={shipping.trackingNumber}
                        maxLength={200}
                        placeholder="Consignment or tracking number"
                        onChange={(event) => updateShipping('trackingNumber', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Vehicle number
                      <input
                        value={shipping.vehicleNumber}
                        maxLength={40}
                        placeholder="e.g. MH 01 AB 1234"
                        onChange={(event) => updateShipping('vehicleNumber', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Dispatch date
                      <input
                        type="date"
                        min="2000-01-01"
                        max="2199-12-31"
                        value={shipping.dispatchDate}
                        onChange={(event) => updateShipping('dispatchDate', event.target.value)}
                      />
                    </label>
                    <label className="doc-field">
                      Delivery date
                      <input
                        type="date"
                        min={shipping.dispatchDate || '2000-01-01'}
                        max="2199-12-31"
                        aria-invalid={!!errors.shipping}
                        value={shipping.deliveryDate}
                        onChange={(event) => updateShipping('deliveryDate', event.target.value)}
                      />
                    </label>
                  </div>
                  {errorFor('shipping')}
                  <label className="doc-field doc-shipping-instructions">
                    Delivery instructions
                    <textarea
                      rows={2}
                      value={shipping.notes}
                      maxLength={2000}
                      placeholder="Site access, receiving hours or handling instructions"
                      onChange={(event) => updateShipping('notes', event.target.value)}
                    />
                  </label>
                </div>
              )}
            </section>
            {form.installmentPlan && !isDelivery && (
              <section
                className={`doc-plan-summary${planMismatch ? ' doc-plan-mismatch' : ''}`}
                aria-label="Installment plan"
              >
                <div>
                  <strong>{form.installmentPlan.name}</strong>
                  <span>
                    {form.installmentPlan.installments.length} installments · {money(planTotal / 100)}{' '}
                    scheduled
                  </span>
                  {!locked && (
                    <button
                      type="button"
                      className="doc-text-button"
                      onClick={() => update('installmentPlan', null)}
                    >
                      Clear plan
                    </button>
                  )}
                </div>
                <ul>
                  {form.installmentPlan.installments.map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.label}</span>
                      <time dateTime={entry.dueDate}>{entry.dueDate}</time>
                      <strong>{money(entry.amount)}</strong>
                    </li>
                  ))}
                </ul>
                <p className="doc-help">
                  {planMismatch
                    ? 'Your edited document total differs from this plan. Clear the plan before saving and create a revised plan from Payments.'
                    : 'Installments remain attached to this document. Manage the schedule and received payments from Payments.'}
                </p>
                {errorFor('installmentPlan')}
              </section>
            )}
            <section className={`doc-bottom-grid${isDelivery ? ' doc-delivery-bottom' : ''}`}>
              <div className="doc-notes">
                <label className="doc-field">
                  Customer note
                  <textarea
                    rows={3}
                    placeholder="A personal note or additional details for your customer"
                    value={form.notes}
                    maxLength={5000}
                    onChange={(event) => update('notes', event.target.value)}
                  />
                </label>
                <label className="doc-field">
                  Terms & conditions
                  <textarea
                    rows={3}
                    placeholder="Payment terms, delivery details and other conditions"
                    value={form.terms}
                    maxLength={5000}
                    onChange={(event) => update('terms', event.target.value)}
                  />
                </label>
                <p className="doc-help">
                  {existing && !financialChange
                    ? 'Saved seller and contact details are retained unless financial details change.'
                    : 'This organization’s seller identity, payment details and contact information will be saved with this document.'}
                </p>
              </div>
              {!isDelivery && (
                <div className="doc-totals-card">
                  <div>
                    <span>Subtotal</span>
                    <strong>{money(totals.subtotal)}</strong>
                  </div>
                  <div className="doc-discount-row">
                    <label htmlFor="doc-discount">
                      Discount{' '}
                      <span className="doc-discount-input">
                        <input
                          disabled={locked}
                          id="doc-discount"
                          aria-label="Discount percentage"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={form.discountPercent}
                          aria-invalid={!!errors.discountPercent}
                          onChange={(event) => update('discountPercent', Number(event.target.value))}
                        />
                        <span>%</span>
                      </span>
                    </label>
                    <span>− {money(totals.discount)}</span>
                  </div>
                  {errorFor('discountPercent')}
                  <div>
                    <span>Taxable amount</span>
                    <span>{money(totals.taxable)}</span>
                  </div>
                  {totals.igst > 0 ? (
                    <div>
                      <span>IGST</span>
                      <span>{money(totals.igst)}</span>
                    </div>
                  ) : (
                    <>
                      <div>
                        <span>CGST</span>
                        <span>{money(totals.cgst)}</span>
                      </div>
                      <div>
                        <span>SGST / UTGST</span>
                        <span>{money(totals.sgst)}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
            {!isDelivery && (
              <div className="doc-total-banner">
                <span>
                  Total {label} value <small>INR · inclusive of applicable taxes</small>
                </span>
                <strong>{money(totals.total)}</strong>
              </div>
            )}
          </div>
        </fieldset>
        <footer className="doc-page-footer">
          {serverError ? (
            <p className="doc-save-error" role="alert">
              {serverError}
            </p>
          ) : (
            <p>
              {finalized ? (
                <>
                  <Check size={14} /> Finalized invoice · all details are locked.
                </>
              ) : (
                <>
                  <Save size={14} /> Your document will be saved to {organization.name}.
                </>
              )}
            </p>
          )}
          <div>
            <button
              className="doc-button doc-button-secondary"
              type="button"
              onClick={onClose}
              disabled={saving || uploadBusy}
            >
              <ArrowLeft size={15} /> Back
            </button>
            {!finalized && (
              <button className="doc-button doc-button-primary" type="submit" disabled={saving || uploadBusy}>
                {saving ? <LoaderCircle size={16} className="doc-spinning" /> : <Save size={16} />}
                {saving ? 'Saving…' : uploadBusy ? 'Reading images…' : `Save ${label}`}
                {!saving && <ArrowRight size={15} />}
              </button>
            )}
          </div>
        </footer>
      </form>
    </section>
  );
}
