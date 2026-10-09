import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Copy,
  Layers3,
  LoaderCircle,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import {
  CATALOG_UNITS,
  calculateLineAmount,
  money,
  pricingDescription,
  type BillingProfile,
  type BusinessProduct,
  type CatalogInput,
  type CatalogItem,
  type CatalogType,
  type Organization,
} from '../../../shared/types';
import { BILLING_PROFILES, billingProfileFor, emptyJewelleryPricing } from '../../../shared/billing-presets';
import PricingFields, { validatePricing } from './PricingFields';
import type { ManagerNavigation, ManagerPage } from '../../app/manager-page';
import './catalog.css';

interface Props extends ManagerNavigation {
  organization: Organization;
  items: CatalogItem[];
  businessProducts?: BusinessProduct[];
  onSave: (input: CatalogInput, id?: string) => Promise<void>;
  onCreateDocument: () => void;
}
type Suggestion = Pick<CatalogInput, 'name' | 'type' | 'unit'> & Partial<Pick<CatalogInput, 'pricing'>>;
function suggestionsFor(profile: BillingProfile): Suggestion[] {
  if (profile === 'legal')
    return [
      { name: 'Legal consultation', type: 'service', unit: 'Hour' },
      { name: 'Agreement drafting', type: 'service', unit: 'Draft' },
      {
        name: 'Legal retainer',
        type: 'service',
        unit: 'Case',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Month' },
      },
    ];
  if (profile === 'facility')
    return [
      {
        name: 'Facility staffing',
        type: 'service',
        unit: 'Person',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Month' },
      },
      {
        name: 'Housekeeping service',
        type: 'service',
        unit: 'Shift',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Day' },
      },
      { name: 'Cleaning supplies', type: 'product', unit: 'Unit' },
    ];
  if (profile === 'elevator')
    return [
      {
        name: 'Elevator maintenance',
        type: 'service',
        unit: 'Lift',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Year' },
      },
      { name: 'Repair visit', type: 'service', unit: 'Visit' },
      { name: 'Elevator spare part', type: 'product', unit: 'Piece' },
    ];
  if (profile === 'space')
    return [
      { name: 'Space planning', type: 'service', unit: 'Sq ft' },
      {
        name: 'Workspace subscription',
        type: 'service',
        unit: 'Seat',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Month' },
      },
      { name: 'Workspace furniture', type: 'product', unit: 'Unit' },
    ];
  if (profile === 'jewellery')
    return [
      { name: 'Jewellery item', type: 'product', unit: 'Piece', pricing: emptyJewelleryPricing() },
      { name: 'Repair & polishing', type: 'service', unit: 'Service' },
      { name: 'Custom design', type: 'service', unit: 'Project' },
    ];
  if (profile === 'ecosystem')
    return [
      {
        name: 'Software subscription',
        type: 'service',
        unit: 'User',
        pricing: { mode: 'recurring', periods: 1, periodUnit: 'Month' },
      },
      { name: 'Product setup', type: 'service', unit: 'Project' },
      { name: 'Product license', type: 'product', unit: 'License' },
    ];
  return [
    { name: 'Business consultation', type: 'service', unit: 'Hour' },
    { name: 'Project coordination', type: 'service', unit: 'Project' },
    { name: 'Product package', type: 'product', unit: 'Set' },
  ];
}
const rateBasis = (item: CatalogItem) =>
  item.pricing?.mode === 'jewellery'
    ? 'per gram of net metal'
    : item.pricing?.mode === 'recurring'
      ? `per ${item.unit} / ${(item.pricing.periodUnit || 'Month').toLowerCase()}`
      : `per ${item.unit}`;
const pricingSummary = (item: CatalogItem) =>
  pricingDescription({ ...item, quantity: 1, description: item.description || item.name });

export default function CatalogManager({
  organization,
  items,
  businessProducts = [],
  onSave,
  onCreateDocument,
  page: requestedPage,
  onNavigate,
}: Props) {
  const [filter, setFilter] = useState<'all' | CatalogType | 'archived'>('all');
  const [search, setSearch] = useState('');
  const [localPage, setLocalPage] = useState<ManagerPage | null>(null);
  const childPage = requestedPage === undefined ? localPage : requestedPage;
  const navigate = (next: ManagerPage | null) => {
    setError('');
    if (onNavigate) onNavigate(next);
    else setLocalPage(next);
  };
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [productFilter, setProductFilter] = useState('all');
  const profile = billingProfileFor(organization);
  const orgProducts = businessProducts.filter((product) => product.organizationId === organization.id);
  const productName = (id?: string) =>
    orgProducts.find((product) => product.id === id)?.name ||
    (id ? 'Archived business product' : 'Shared offering');
  function newItem(type: CatalogType): Partial<CatalogInput> {
    const unit =
      type === 'product'
        ? profile === 'jewellery'
          ? 'Piece'
          : profile === 'ecosystem'
            ? 'License'
            : 'Nos'
        : BILLING_PROFILES[profile].units[0];
    return {
      type,
      unit,
      ...(profile === 'jewellery' && type === 'product' ? { pricing: emptyJewelleryPricing() } : {}),
      ...(orgProducts.some((product) => product.id === productFilter && product.active)
        ? { businessProductId: productFilter }
        : {}),
    };
  }
  const scopedItems = items.filter((item) => item.organizationId === organization.id);
  const active = scopedItems.filter((item) => item.active);
  const products = active.filter((item) => item.type === 'product');
  const services = active.filter((item) => item.type === 'service');
  const filtered = useMemo(
    () =>
      items
        .filter((item) => item.organizationId === organization.id)
        .filter(
          (item) =>
            (filter === 'archived'
              ? !item.active
              : item.active && (filter === 'all' || item.type === filter)) &&
            (productFilter === 'all' || productFilter === 'shared'
              ? productFilter !== 'shared' || !item.businessProductId
              : item.businessProductId === productFilter) &&
            `${item.name} ${item.sku} ${item.description} ${item.hsn} ${orgProducts.find((product) => product.id === item.businessProductId)?.name || ''}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items, organization.id, filter, search, productFilter, businessProducts],
  );
  useEffect(() => setPage(0), [filter, search, productFilter]);
  useEffect(() => {
    setProductFilter('all');
    setFilter('all');
    setSearch('');
    setLocalPage(null);
    setError('');
  }, [organization.id]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 15) - 1));
  const visible = filtered.slice(currentPage * 15, (currentPage + 1) * 15);
  async function toggleArchive(item: CatalogItem) {
    if (busy) return;
    setBusy(item.id);
    setError('');
    try {
      await onSave({ ...item, active: !item.active }, item.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }
  function exportCatalog() {
    const rows = [
      [
        'Name',
        'Business product',
        'Type',
        'SKU',
        'Description',
        'HSN/SAC',
        'Unit',
        'Base rate (INR)',
        'Rate basis',
        'Pricing mode',
        'Periods',
        'Period unit',
        'Gross weight (g)',
        'Stone weight (g)',
        'Purity',
        'Making basis',
        'Making charge',
        'Stone amount (INR)',
        'Other charges (INR)',
        'Wastage %',
        'Amount for one item (INR)',
        'Pricing details',
        'GST %',
        'Status',
      ],
      ...filtered.map((item) => {
        const j = item.pricing?.jewellery;
        return [
          item.name,
          productName(item.businessProductId),
          item.type,
          item.sku,
          item.description,
          item.hsn,
          item.unit,
          item.rate,
          rateBasis(item),
          item.pricing?.mode || 'standard',
          item.pricing?.periods ?? '',
          item.pricing?.periodUnit ?? '',
          j?.grossWeight ?? '',
          j?.stoneWeight ?? '',
          j?.purity ?? '',
          j?.makingChargeType ?? '',
          j?.makingCharge ?? '',
          j?.stoneAmount ?? '',
          j?.otherCharges ?? '',
          j?.wastagePercent ?? '',
          calculateLineAmount({ quantity: 1, rate: item.rate, pricing: item.pricing }),
          pricingSummary(item),
          item.gstRate,
          item.active ? 'Active' : 'Archived',
        ];
      }),
    ];
    const text = rows
      .map((row) =>
        row
          .map((value) => {
            let s = String(value);
            if (/^\s*[=+@-]/.test(s)) s = "'" + s;
            return `"${s.replaceAll('"', '""')}"`;
          })
          .join(','),
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${organization.name.replace(/[^a-z0-9]+/gi, '-')}-catalog.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  if (childPage) {
    const source = childPage.id ? scopedItems.find((item) => item.id === childPage.id) : undefined;
    if (
      childPage.action === 'delete' ||
      (childPage.action === 'edit' && !source) ||
      (childPage.id && !source)
    )
      return (
        <section className="panel cat-page-message">
          <h2>
            {childPage.action === 'delete' ? 'Archive items from your catalog' : 'Catalog item not found'}
          </h2>
          <p>This item may no longer be available in {organization.name}.</p>
          <button className="button secondary" onClick={() => navigate(null)}>
            <ArrowLeft size={16} />
            Back to products & services
          </button>
        </section>
      );
    const suggestion = suggestionsFor(profile).find((item) => item.name === childPage.suggestion);
    const initial =
      source && childPage.action === 'new'
        ? { ...source, name: `${source.name} (copy)`, sku: '', active: true }
        : {
            ...newItem(childPage.itemType || 'service'),
            ...suggestion,
            ...(childPage.businessProductId ? { businessProductId: childPage.businessProductId } : {}),
          };
    return (
      <CatalogEditor
        key={JSON.stringify(childPage)}
        organization={organization}
        businessProducts={orgProducts}
        item={childPage.action === 'edit' ? source : undefined}
        initial={initial}
        onClose={() => navigate(null)}
        onSave={async (input, id) => {
          await onSave(input, id);
          navigate(null);
        }}
      />
    );
  }
  return (
    <div className="cat-workspace">
      <section className="cat-intro">
        <div className="cat-intro-copy">
          <span className="cat-kicker">
            <Layers3 size={14} /> YOUR OFFERINGS, ORGANIZED
          </span>
          <h2>
            Save it once.
            <br />
            Invoice it in seconds.
          </h2>
          <p>A reusable library of everything {organization.name} offers.</p>
          <div className="cat-intro-actions">
            <button
              className="button primary"
              onClick={() =>
                navigate({
                  action: 'new',
                  itemType: 'service',
                  businessProductId:
                    productFilter === 'all' || productFilter === 'shared' ? undefined : productFilter,
                })
              }
            >
              <Plus size={16} />
              Add service
            </button>
            <button
              className="button secondary"
              onClick={() =>
                navigate({
                  action: 'new',
                  itemType: 'product',
                  businessProductId:
                    productFilter === 'all' || productFilter === 'shared' ? undefined : productFilter,
                })
              }
            >
              <Plus size={16} />
              Add product
            </button>
          </div>
        </div>
        <div className="cat-stats">
          <div>
            <span className="cat-stat-icon service">
              <BriefcaseBusiness size={23} />
            </span>
            <strong>{String(services.length).padStart(2, '0')}</strong>
            <span>Active services</span>
          </div>
          <div>
            <span className="cat-stat-icon product">
              <Package size={23} />
            </span>
            <strong>{String(products.length).padStart(2, '0')}</strong>
            <span>Active products</span>
          </div>
        </div>
      </section>
      <div className="cat-profile-banner">
        <BriefcaseBusiness size={18} />
        <div>
          <strong>{BILLING_PROFILES[profile].label}</strong>
          <p>{BILLING_PROFILES[profile].hint}. Set your own prices and applicable GST.</p>
        </div>
        {orgProducts.length > 0 && (
          <span>{orgProducts.filter((product) => product.active).length} business products</span>
        )}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss catalog error">
            <X size={16} />
          </button>
        </div>
      )}
      <section className="panel cat-panel">
        <div className="cat-toolbar">
          <div className="filter-tabs">
            {(
              [
                ['all', 'All items', active.length],
                ['service', 'Services', services.length],
                ['product', 'Products', products.length],
                ['archived', 'Archived', scopedItems.length - active.length],
              ] as const
            ).map(([key, label, count]) => (
              <button className={filter === key ? 'selected' : ''} key={key} onClick={() => setFilter(key)}>
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <div className="cat-toolbar-actions">
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="Search catalog"
                placeholder="Search name, SKU or HSN…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button className="button secondary" onClick={exportCatalog} disabled={!filtered.length}>
              <ArrowDownToLine size={15} />
              Export
            </button>
          </div>
        </div>
        {(orgProducts.length > 0 || organization.enableProductSelection) && (
          <div className="cat-product-filter">
            <label>
              Business product
              <select
                aria-label="Filter catalog by business product"
                value={productFilter}
                onChange={(event) => setProductFilter(event.target.value)}
              >
                <option value="all">All business products</option>
                <option value="shared">Shared offerings</option>
                {orgProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                    {product.active ? '' : ' (archived)'}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Keep a price list for each business product, with shared offerings available across the
              organization.
            </p>
          </div>
        )}
        {visible.length ? (
          <div className="table-scroll">
            <table className="data-table cat-table">
              <thead>
                <tr>
                  <th>PRODUCT / SERVICE</th>
                  <th>TYPE</th>
                  <th>HSN / SAC</th>
                  <th>BILLING / PRICE</th>
                  <th>GST</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="document-cell">
                        <span className={`cat-item-icon ${item.type}`}>
                          {item.type === 'service' ? <BriefcaseBusiness size={19} /> : <Package size={19} />}
                        </span>
                        <div>
                          <button
                            className="text-button cat-name"
                            onClick={() => navigate({ action: 'edit', id: item.id })}
                          >
                            {item.name}
                          </button>
                          <span>
                            {item.sku ? `SKU: ${item.sku}` : item.description || 'No description added'}
                          </span>
                          {orgProducts.length > 0 && (
                            <small className="cat-product-tag">{productName(item.businessProductId)}</small>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`cat-type ${item.type}`}>{item.type}</span>
                    </td>
                    <td className="mono">{item.hsn || '—'}</td>
                    <td className="amount cat-billing-cell">
                      {money(item.rate)}
                      <small>{rateBasis(item)}</small>
                      {item.pricing && item.pricing.mode !== 'standard' && (
                        <>
                          <span className="cat-pricing-mode">
                            {item.pricing.mode === 'jewellery'
                              ? 'Weight + charges'
                              : `${item.pricing.periods ?? 1} ${(item.pricing.periodUnit || 'Month').toLowerCase()} period`}
                          </span>
                          <small className="cat-computed-price">
                            {money(
                              calculateLineAmount({ quantity: 1, rate: item.rate, pricing: item.pricing }),
                            )}{' '}
                            / {item.unit}
                            {item.pricing.mode === 'recurring' ? ' for this period' : ' before GST'}
                          </small>
                        </>
                      )}
                    </td>
                    <td>{item.gstRate}%</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`Edit ${item.name}`}
                          title="Edit item"
                          onClick={() => navigate({ action: 'edit', id: item.id })}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Duplicate ${item.name}`}
                          title="Duplicate item"
                          onClick={() => navigate({ action: 'new', id: item.id })}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={!!busy}
                          aria-label={`${item.active ? 'Archive' : 'Restore'} ${item.name}`}
                          title={item.active ? 'Archive item' : 'Restore item'}
                          onClick={() => toggleArchive(item)}
                        >
                          {busy === item.id ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : item.active ? (
                            <Archive size={15} />
                          ) : (
                            <RotateCcw size={15} />
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
          <div className="empty-state cat-empty">
            <div className="cat-empty-icons">
              <span>
                <Package size={26} />
              </span>
              <span>
                <BriefcaseBusiness size={26} />
              </span>
            </div>
            <h3>
              {search
                ? 'No matching items'
                : filter === 'archived'
                  ? 'Nothing archived here'
                  : 'Your expertise deserves a place of its own'}
            </h3>
            <p>
              {search
                ? 'Try a different name, SKU or HSN code.'
                : filter === 'archived'
                  ? 'Archived items stay saved, but won’t appear in new document pickers.'
                  : 'Add your products and services with their prices. Bring them into any quotation or invoice with a click.'}
            </p>
            {!search && filter !== 'archived' && (
              <button
                className="text-button green"
                onClick={() =>
                  navigate({ action: 'new', itemType: filter === 'product' ? 'product' : 'service' })
                }
              >
                Add your first {filter === 'product' ? 'product' : 'service'}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        )}
        <div className="cat-footer">
          <span>
            {filtered.length} items · {organization.name}
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
          <button className="text-button green" onClick={onCreateDocument}>
            Create an invoice
            <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <section className="cat-suggestions">
        <div>
          <Sparkles size={19} />
          <h3>A starting point for {organization.name}</h3>
          <p>Optional ideas—choose one, then set your own description, price and tax.</p>
        </div>
        <div className="cat-suggestion-list">
          {suggestionsFor(profile).map((suggestion) => (
            <button
              key={suggestion.name}
              onClick={() =>
                navigate({
                  action: 'new',
                  suggestion: suggestion.name,
                  itemType: suggestion.type,
                  businessProductId: orgProducts.some(
                    (product) => product.id === productFilter && product.active,
                  )
                    ? productFilter
                    : undefined,
                })
              }
            >
              <span className={`cat-item-icon ${suggestion.type}`}>
                {suggestion.type === 'service' ? <BriefcaseBusiness size={16} /> : <Package size={16} />}
              </span>
              <span>
                {suggestion.name}
                <small>
                  {suggestion.type} ·{' '}
                  {suggestion.pricing?.mode === 'jewellery'
                    ? 'weight + making charges'
                    : suggestion.pricing?.mode === 'recurring'
                      ? `per ${suggestion.unit} / ${suggestion.pricing.periodUnit?.toLowerCase()}`
                      : `per ${suggestion.unit}`}
                </small>
              </span>
              <Plus size={16} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function CatalogEditor({
  organization,
  businessProducts,
  item,
  initial,
  onClose,
  onSave,
}: {
  organization: Organization;
  businessProducts: BusinessProduct[];
  item?: CatalogItem;
  initial?: Partial<CatalogInput>;
  onClose: () => void;
  onSave: (input: CatalogInput, id?: string) => Promise<void>;
}) {
  const [form, setForm] = useState<CatalogInput>(() => ({
    organizationId: organization.id,
    type: 'service',
    name: '',
    description: '',
    sku: '',
    hsn: '',
    unit: 'Service',
    rate: NaN,
    gstRate: NaN,
    active: true,
    ...initial,
    ...item,
  }));
  const [busy, setBusy] = useState(false);
  const profile = billingProfileFor(organization);
  const suggestedUnits = [...new Set([...BILLING_PROFILES[profile].units, ...CATALOG_UNITS])];
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[name="catalog-name"]')?.focus();
  }, []);
  const change = <K extends keyof CatalogInput>(key: K, value: CatalogInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    if (!form.name.trim() || !form.unit.trim()) {
      setError('Add a name and unit for this item.');
      return;
    }
    if (form.hsn && !/^\d{4,8}$/.test(form.hsn)) {
      setError('HSN / SAC must contain 4–8 digits, or can be left blank.');
      return;
    }
    if (
      ![form.rate, form.gstRate].every(Number.isFinite) ||
      form.rate < 0 ||
      form.gstRate < 0 ||
      form.gstRate > 40
    ) {
      setError('Enter a valid price and GST rate (0–40%).');
      return;
    }
    const pricingError = validatePricing(form.pricing);
    if (pricingError) {
      setError(pricingError);
      return;
    }
    if (calculateLineAmount({ quantity: 1, rate: form.rate, pricing: form.pricing }) > 1000000000) {
      setError('The calculated amount for one item cannot exceed ₹100 crore.');
      return;
    }
    setBusy(true);
    saving.current = true;
    setError('');
    try {
      await onSave(
        {
          ...form,
          name: form.name.trim(),
          description: form.description.trim(),
          sku: form.sku.trim(),
          hsn: form.hsn.trim(),
          unit: form.unit.trim(),
        },
        item?.id,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="cat-editor-page">
      <button className="button secondary cat-back" type="button" onClick={onClose} disabled={busy}>
        <ArrowLeft size={16} />
        Back to products & services
      </button>
      <section className="panel cat-editor" ref={ref} aria-labelledby="catalog-title">
        <header className="cat-editor-heading">
          <div className="cat-editor-icon">
            {form.type === 'service' ? <BriefcaseBusiness size={22} /> : <Package size={22} />}
          </div>
          <div>
            <h2 id="catalog-title">
              {item ? 'Edit' : 'Add'} {form.type}
            </h2>
            <p>Save to {organization.name}’s catalog.</p>
          </div>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="cat-fieldset">
            <div className="cat-editor-body">
              <div className="cat-type-picker">
                {(['service', 'product'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={form.type === type}
                    className={form.type === type ? 'selected' : ''}
                    onClick={() => {
                      change('type', type);
                      if (['Service', 'Nos'].includes(form.unit))
                        change('unit', type === 'service' ? 'Service' : 'Nos');
                    }}
                  >
                    {type === 'service' ? <BriefcaseBusiness size={18} /> : <Package size={18} />}
                    <span>
                      {type === 'service' ? 'Service' : 'Product'}
                      <small>
                        {type === 'service'
                          ? 'Work, expertise or a recurring service'
                          : 'A physical or digital item'}
                      </small>
                    </span>
                    {form.type === type && <Check size={17} />}
                  </button>
                ))}
              </div>
              <div className="form-grid">
                <label className="span-two">
                  {form.type === 'service' ? 'Service' : 'Product'} name <span className="required">*</span>
                  <input
                    name="catalog-name"
                    required
                    maxLength={200}
                    value={form.name}
                    onChange={(e) => change('name', e.target.value)}
                    placeholder={
                      form.type === 'service' ? 'e.g. Annual maintenance' : 'e.g. Replacement component'
                    }
                  />
                </label>
                {(businessProducts.length > 0 || organization.enableProductSelection) && (
                  <label className="span-two">
                    Business product
                    <select
                      aria-label="Business product"
                      value={form.businessProductId || ''}
                      onChange={(e) => change('businessProductId', e.target.value)}
                    >
                      <option value="">Shared offering · all business products</option>
                      {businessProducts
                        .filter((product) => product.active || product.id === form.businessProductId)
                        .map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name}
                            {product.active ? '' : ' (archived)'}
                          </option>
                        ))}
                    </select>
                    <span className="field-hint">
                      Assign this offering to one product line, or keep it available across the organization.
                    </span>
                  </label>
                )}
                <label className="span-two">
                  Description
                  <textarea
                    rows={2}
                    maxLength={1800}
                    value={form.description}
                    onChange={(e) => change('description', e.target.value)}
                    placeholder="Details to include when adding this item to a document"
                  />
                </label>
                <label>
                  SKU / reference code
                  <input
                    maxLength={80}
                    value={form.sku}
                    onChange={(e) => change('sku', e.target.value)}
                    placeholder="e.g. SVC-001"
                  />
                </label>
                <label>
                  HSN / SAC code
                  <input
                    maxLength={8}
                    inputMode="numeric"
                    value={form.hsn}
                    onChange={(e) => change('hsn', e.target.value.replace(/\D/g, ''))}
                    placeholder="Optional · 4 to 8 digits"
                  />
                </label>
                <label>
                  {form.pricing?.mode === 'jewellery'
                    ? 'Metal rate (₹/g)'
                    : form.pricing?.mode === 'recurring'
                      ? `Rate per ${form.unit || 'unit'} / ${(form.pricing.periodUnit || 'Month').toLowerCase()} (₹)`
                      : 'Selling price (₹)'}{' '}
                  <span className="required">*</span>
                  <input
                    type="number"
                    min="0"
                    max="100000000"
                    step="0.01"
                    required
                    value={Number.isNaN(form.rate) ? '' : form.rate}
                    onChange={(e) => change('rate', e.target.value === '' ? NaN : Number(e.target.value))}
                  />
                </label>
                <label>
                  Unit <span className="required">*</span>
                  <input
                    list="catalog-units"
                    value={form.unit}
                    maxLength={20}
                    required
                    onChange={(e) => change('unit', e.target.value)}
                    placeholder="e.g. Month, Gram, Nos"
                  />
                  <datalist id="catalog-units">
                    {suggestedUnits.map((unit) => (
                      <option key={unit} value={unit} />
                    ))}
                  </datalist>
                </label>
                <label>
                  GST rate (%)
                  <input
                    type="number"
                    min="0"
                    max="40"
                    step="0.01"
                    required
                    value={Number.isNaN(form.gstRate) ? '' : form.gstRate}
                    onChange={(e) => change('gstRate', e.target.value === '' ? NaN : Number(e.target.value))}
                  />
                  <span className="field-hint">
                    Enter the applicable rate, including 0 for an exempt item.
                  </span>
                </label>
                <div className="cat-price-note">
                  <Tag size={17} />
                  <p>
                    Prices are before GST.
                    <br />
                    <span>You can adjust the price on each draft document.</span>
                  </p>
                </div>
              </div>
              <div className="cat-pricing-fields">
                <PricingFields
                  value={form.pricing}
                  onChange={(pricing) => {
                    setForm((current) => ({
                      ...current,
                      pricing,
                      unit: pricing?.mode === 'jewellery' ? 'Piece' : current.unit,
                    }));
                    setError('');
                  }}
                  rate={form.rate}
                  unit={form.unit}
                  quantity={1}
                  profile={profile}
                  disabled={busy}
                  idPrefix="catalog"
                />
              </div>
              <div className="cat-snapshot-note">
                <Check size={15} />
                <p>
                  {item
                    ? 'Changes apply when you next add this item. Saved quotations and invoices keep their original prices.'
                    : 'Only this organization can select this item from its catalog.'}
                </p>
              </div>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          </fieldset>
          <footer className="cat-editor-footer">
            <span>
              <span className="required">*</span> Required fields
            </span>
            <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              {busy ? 'Saving…' : item ? 'Save changes' : `Save ${form.type}`}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
