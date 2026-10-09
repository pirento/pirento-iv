import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import type { BusinessProduct, BusinessProductInput, Organization } from '../../../shared/types';
import type { ManagerNavigation, ManagerPage } from '../../app/manager-page';
import './business-products.css';

interface Props extends ManagerNavigation {
  organization: Organization;
  products: BusinessProduct[];
  onSave: (input: BusinessProductInput, id?: string) => Promise<void>;
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase() || 'BP';
const asInput = ({
  id: _id,
  createdAt: _created,
  updatedAt: _updated,
  ...input
}: BusinessProduct): BusinessProductInput => input;

export default function BusinessProductsManager({
  organization,
  products,
  onSave,
  page: requestedPage,
  onNavigate,
}: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [localPage, setLocalPage] = useState<ManagerPage | null>(null);
  const childPage = requestedPage === undefined ? localPage : requestedPage;
  const navigate = (next: ManagerPage | null) => {
    setError('');
    if (onNavigate) onNavigate(next);
    else setLocalPage(next);
  };
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const organizationProducts = products.filter((product) => product.organizationId === organization.id);
  const activeCount = organizationProducts.filter((product) => product.active).length;
  const archivedCount = organizationProducts.length - activeCount;
  const visible = useMemo(
    () =>
      organizationProducts.filter(
        (product) =>
          (filter === 'all' || product.active === (filter === 'active')) &&
          `${product.name} ${product.code} ${product.description}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [products, organization.id, filter, search],
  );
  useEffect(() => {
    setSearch('');
    setFilter('active');
    setLocalPage(null);
    setError('');
  }, [organization.id]);

  async function changeActive(product: BusinessProduct) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(product.id);
    setError('');
    try {
      await onSave({ ...asInput(product), active: !product.active }, product.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to update this business product. Please try again.',
      );
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }

  if (childPage) {
    const source = childPage.id
      ? organizationProducts.find((product) => product.id === childPage.id)
      : undefined;
    if (
      childPage.action === 'delete' ||
      (childPage.action === 'edit' && !source) ||
      (childPage.id && !source)
    )
      return (
        <section className="panel bp-page-message">
          <h2>
            {childPage.action === 'delete'
              ? 'Archive products from the product directory'
              : 'Business product not found'}
          </h2>
          <p>This product may no longer be available in {organization.name}.</p>
          <button className="button secondary" onClick={() => navigate(null)}>
            <ArrowLeft size={16} />
            Back to business products
          </button>
        </section>
      );
    return (
      <BusinessProductEditor
        key={`${childPage.action}-${childPage.id || 'new'}`}
        organization={organization}
        product={childPage.action === 'edit' ? source : undefined}
        initial={
          source && childPage.action === 'new'
            ? { ...asInput(source), name: `${source.name} (copy)`, code: '', active: true }
            : undefined
        }
        onClose={() => navigate(null)}
        onSave={async (input, id) => {
          await onSave(input, id);
          navigate(null);
        }}
      />
    );
  }
  return (
    <div className="bp-workspace">
      <section className="bp-intro">
        <div className="bp-intro-symbol">
          <Layers3 size={30} />
        </div>
        <div>
          <span className="bp-eyebrow">ONE ECOSYSTEM. EVERY PRODUCT.</span>
          <h2>A place for each business product.</h2>
          <p>Organize {organization.name}’s product lines, with their own identity and offerings.</p>
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() => {
              setError('');
              navigate({ action: 'new' });
            }}
          >
            <Plus size={16} />
            Add business product
          </button>
        </div>
        <div className="bp-count">
          <strong>{String(activeCount).padStart(2, '0')}</strong>
          <span>ACTIVE PRODUCTS</span>
        </div>
      </section>
      <div className="bp-guidance">
        <Box size={18} />
        <p>
          <strong>Business products group related offerings.</strong>
          <span>
            Add their services, subscriptions and prices in Products & services, then select the business
            product when creating a document.
          </span>
        </p>
      </div>
      {error && (
        <div className="bp-error" role="alert">
          {error}
          <button
            className="icon-button"
            aria-label="Dismiss business product error"
            onClick={() => setError('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="bp-toolbar">
        <div className="bp-tabs" aria-label="Filter business products">
          {(
            [
              ['active', 'Active', activeCount],
              ['archived', 'Archived', archivedCount],
              ['all', 'All products', organizationProducts.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={filter === value ? 'selected' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <label className="bp-search">
          <Search size={16} />
          <input
            aria-label="Search business products"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or code…"
          />
          {search && (
            <button type="button" aria-label="Clear business product search" onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      <div className="bp-grid">
        {visible.map((product) => (
          <article className={`bp-card ${product.active ? '' : 'bp-card-archived'}`} key={product.id}>
            <div className="bp-card-top">
              <div className="bp-logo">
                {product.logoUrl ? (
                  <img src={product.logoUrl} alt={`${product.name} logo`} />
                ) : (
                  <span>{initials(product.name)}</span>
                )}
              </div>
              <span className={`bp-status ${product.active ? 'active' : ''}`}>
                <i />
                {product.active ? 'Active' : 'Archived'}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${product.name}`}
                onClick={() => navigate({ action: 'edit', id: product.id })}
                disabled={!!busy}
              >
                <Pencil size={16} />
              </button>
            </div>
            <h3>{product.name}</h3>
            <span className="bp-code">{product.code || 'No reference code'}</span>
            <p>{product.description || 'Add a description to help your team identify this product line.'}</p>
            <div className="bp-card-footer">
              <button
                className="text-button green"
                onClick={() => navigate({ action: 'edit', id: product.id })}
                disabled={!!busy}
              >
                Product details
                <ArrowRight size={13} />
              </button>
              <button
                className="bp-archive-action"
                aria-label={`${product.active ? 'Archive' : 'Restore'} ${product.name}`}
                onClick={() => void changeActive(product)}
                disabled={!!busy}
              >
                {busy === product.id ? (
                  <LoaderCircle className="bp-spin" size={14} />
                ) : product.active ? (
                  <Archive size={14} />
                ) : (
                  <RotateCcw size={14} />
                )}
                {product.active ? 'Archive' : 'Restore'}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <div className="bp-empty">
          <div>
            <Layers3 size={30} />
          </div>
          <h3>
            {search
              ? 'No matching business products'
              : filter === 'archived'
                ? 'No archived business products'
                : 'Give your next product a home'}
          </h3>
          <p>
            {search
              ? 'Try another product name or reference code.'
              : filter === 'archived'
                ? 'Archived products remain saved and can be restored whenever you need them.'
                : 'Create a product line, then add its offerings to your organization’s catalog.'}
          </p>
          {!search && filter !== 'archived' && (
            <button className="button primary" onClick={() => navigate({ action: 'new' })}>
              <Plus size={15} />
              Add business product
            </button>
          )}
        </div>
      )}
      <div className="bp-footnote">
        <Check size={14} />
        <p>
          Archiving removes a product from new selections. Existing offerings and saved documents retain their
          records.
        </p>
      </div>
    </div>
  );
}

function BusinessProductEditor({
  organization,
  product,
  initial,
  onSave,
  onClose,
}: {
  organization: Organization;
  product?: BusinessProduct;
  initial?: BusinessProductInput;
  onSave: Props['onSave'];
  onClose: () => void;
}) {
  const [form, setForm] = useState<BusinessProductInput>(() =>
    product
      ? asInput(product)
      : (initial ?? {
          organizationId: organization.id,
          name: '',
          code: '',
          description: '',
          logoUrl: '',
          active: true,
        }),
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploadName, setUploadName] = useState(product?.logoUrl ? 'Saved product logo' : '');
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const change = <K extends keyof BusinessProductInput>(key: K, value: BusinessProductInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busyRef.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPG or WebP product logo.');
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
        reader.onerror = () => reject(new Error('Unable to read this image.'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('This file could not be opened as an image.'));
        image.src = data;
      });
      change('logoUrl', data);
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
      setError('Enter a name for this business product.');
      nameRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(
        { ...form, name: form.name.trim(), code: form.code.trim(), description: form.description.trim() },
        product?.id,
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to save this business product. Please try again.',
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="bp-editor-page">
      <button
        className="button secondary bp-back"
        type="button"
        onClick={onClose}
        disabled={saving || uploading}
      >
        <ArrowLeft size={16} />
        Back to business products
      </button>
      <section className="bp-editor panel" aria-labelledby="bp-editor-title" ref={panelRef}>
        <header className="bp-editor-heading">
          <span>
            <Layers3 size={23} />
          </span>
          <div>
            <p className="bp-eyebrow">YOUR PRODUCT’S IDENTITY</p>
            <h2 id="bp-editor-title">{product ? 'Edit business product' : 'Add business product'}</h2>
            <p>{organization.name}</p>
          </div>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={saving || uploading} className="bp-editor-fields">
            <div className="bp-product-preview">
              <div className="bp-logo">
                {form.logoUrl ? (
                  <img src={form.logoUrl} alt="Product logo preview" />
                ) : (
                  <span>{initials(form.name)}</span>
                )}
              </div>
              <div>
                <strong>{form.name || 'Your business product'}</strong>
                <span>{form.code || organization.name}</span>
              </div>
              <span className={`bp-status ${form.active ? 'active' : ''}`}>
                <i />
                {form.active ? 'Active' : 'Archived'}
              </span>
            </div>
            <label className="bp-field">
              Business product name <span>*</span>
              <input
                ref={nameRef}
                required
                maxLength={200}
                value={form.name}
                onChange={(event) => change('name', event.target.value)}
                placeholder="Enter your product line’s name"
              />
            </label>
            <label className="bp-field">
              Reference code
              <input
                maxLength={80}
                value={form.code}
                onChange={(event) => change('code', event.target.value)}
                placeholder="e.g. PIRENTO-AI"
              />
              <small>Optional short code to identify this business product.</small>
            </label>
            <label className="bp-field">
              Description
              <textarea
                rows={4}
                maxLength={2000}
                value={form.description}
                onChange={(event) => change('description', event.target.value)}
                placeholder="What does this product offer?"
              />
              <small>{form.description.length}/2000</small>
            </label>
            <div className="bp-field">
              Product logo
              <div className="bp-upload">
                <div className="bp-upload-image">
                  {form.logoUrl ? (
                    <img src={form.logoUrl} alt="Current product logo" />
                  ) : (
                    <ImagePlus size={26} />
                  )}
                </div>
                <div>
                  <strong>{uploadName || 'Add an optional logo'}</strong>
                  <span>PNG, JPG or WebP · Up to 500 KB</span>
                  <div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload size={13} />
                      {uploading ? 'Uploading…' : 'Upload logo'}
                    </button>
                    {form.logoUrl && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          change('logoUrl', '');
                          setUploadName('');
                        }}
                      >
                        Remove logo
                      </button>
                    )}
                  </div>
                </div>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  aria-label="Upload business product logo"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={uploadLogo}
                />
              </div>
            </div>
            <label className="bp-active-field">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => change('active', event.target.checked)}
              />
              <span>
                <strong>Active business product</strong>
                <small>Available when selecting a product for new offerings and documents.</small>
              </span>
            </label>
            <p className="bp-editor-note">
              Prices, units, tax and billing rules are saved with each offering in Products & services.
            </p>
          </fieldset>
          <footer className="bp-editor-footer">
            {error && (
              <div className="bp-error" role="alert">
                {error}
              </div>
            )}
            <div>
              <button
                className="button secondary"
                type="button"
                onClick={onClose}
                disabled={saving || uploading}
              >
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={saving || uploading}>
                {saving ? <LoaderCircle size={16} className="bp-spin" /> : <Check size={16} />}
                {saving ? 'Saving…' : product ? 'Save changes' : 'Save business product'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
