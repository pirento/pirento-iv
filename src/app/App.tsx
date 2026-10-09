import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FilePlus2,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wallet,
  X,
  Pencil,
  Trash2,
  ReceiptText,
  Layers3,
  Package,
  PanelsTopLeft,
  BriefcaseBusiness,
  Truck,
  LockKeyhole,
  LogOut,
  PlugZap,
} from 'lucide-react';
import { api, sendJson } from '../shared/api/api';
import {
  COMPANY_NAME,
  blankShipping,
  money,
  DOCUMENT_LABELS,
  STATUS_LABELS,
  paidAmount,
  balanceDue,
  installmentBalances,
  type BusinessDocument,
  type Customer,
  type DocumentInput,
  type DocumentKind,
  type Organization,
  type CatalogItem,
  type CatalogInput,
  type InvoiceFormat,
  type FormatInput,
  type WorkspaceSettings,
  type BusinessProduct,
  type BusinessProductInput,
} from '../../shared/types';
import CustomerEditor from '../features/contacts/CustomerEditor';
import DocumentEditor from '../features/documents/DocumentEditor';
import DocumentPreview from '../features/documents/DocumentPreview';
import OrganizationEditor from '../features/organizations/OrganizationEditor';
import CatalogManager from '../features/catalog/CatalogManager';
import FormatManager from '../features/formats/FormatManager';
import PaymentPanel from '../features/payments/PaymentPanel';
import WorkspaceSettingsEditor from '../features/organizations/WorkspaceSettingsEditor';
import BusinessProductsManager from '../features/catalog/BusinessProductsManager';
import TeamManager from '../features/team/TeamManager';
import ContactsManager from '../features/contacts/ContactsManager';
import MessagingPanel from '../features/messaging/MessagingPanel';
import IntegrationSettings from '../features/integrations/IntegrationSettings';
import { isInvoiceRecipient } from '../../shared/contact-types';
import { isIndependentBusiness, organizationSupportEmail } from '../../shared/business-identity';
import type { AuthUser } from '../../shared/auth-types';
import { useWorkspaceRoute } from './use-workspace-route';
import { workspaceUrl, type WorkspaceRoute, type WorkspaceView } from './workspace-route';
import type { ManagerPage } from './manager-page';
import './workspace-pages.css';

type View = WorkspaceView | 'not_found';
type DocumentEditorState = {
  type: 'document';
  kind: DocumentKind;
  document?: BusinessDocument;
  draft?: DocumentInput;
};
type Editor =
  | DocumentEditorState
  | { type: 'customer'; customer?: Customer }
  | { type: 'organization'; organization?: Organization }
  | null;
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const displayDate = (date: string) =>
  date
    ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(
        new Date(`${date}T12:00:00`),
      )
    : '—';
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
const statusOf = (doc: BusinessDocument) => {
  if (doc.kind !== 'invoice' || !['sent', 'partially_paid'].includes(doc.status)) return doc.status;
  if (doc.installmentPlan?.installments.length)
    return installmentBalances(doc, today()).some((i) => i.status === 'overdue') ? 'overdue' : doc.status;
  return doc.dueDate && doc.dueDate < today() ? 'overdue' : doc.status;
};

const documentListFor: Record<DocumentKind, View> = {
  invoice: 'invoices',
  quotation: 'quotations',
  proforma: 'proformas',
  delivery_note: 'shipping',
};
const documentViews: Partial<Record<View, DocumentKind>> = {
  invoices: 'invoice',
  quotations: 'quotation',
  proformas: 'proforma',
  shipping: 'delivery_note',
};
const statusLabel = (status: string) =>
  status === 'overdue' ? 'Overdue' : STATUS_LABELS[status as keyof typeof STATUS_LABELS] || status;

export default function App({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const isAdmin = user.role === 'admin';
  const { route, navigate: routeNavigate } = useWorkspaceRoute();
  const draftCache = useRef(new Map<string, DocumentInput>());
  const draftKey = (org: string, kind: DocumentKind, id?: string) => `${org}:${kind}:${id || 'new'}`;
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>({
    companyName: COMPANY_NAME,
    dashboardLogoUrl: '',
  });

  const [businessProducts, setBusinessProducts] = useState<BusinessProduct[]>([]);
  const [productFilter, setProductFilter] = useState('all');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [fallbackOrganization, setFallbackOrganization] = useState(
    localStorage.getItem('vc-organization') || localStorage.getItem('vf-organization') || '',
  );
  const organizationId = route?.organizationId || fallbackOrganization;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [documents, setDocuments] = useState<BusinessDocument[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [formats, setFormats] = useState<InvoiceFormat[]>([]);
  const [pendingDocument, setPendingDocument] = useState<DocumentEditorState | null>(null);
  const currentOrganization = useRef(organizationId);
  currentOrganization.current = organizationId;
  const view: View = route?.view || 'overview';
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [loadedOrganization, setLoadedOrganization] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [mobileNav, setMobileNav] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const organization = organizations.find((o) => o.id === organizationId);
  const companyDefaults = organizations.find(
    (org) => !isIndependentBusiness(org) && org.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase(),
  );
  const divisionCount = organizations.filter((org) => !isIndependentBusiness(org)).length;
  const independentCount = organizations.length - divisionCount;

  const loadOrganizations = useCallback(async () => {
    const [data, settings] = await Promise.all([
      api<Organization[]>('/organizations'),
      api<WorkspaceSettings>('/workspace-settings'),
    ]);
    setWorkspaceSettings(settings);
    setOrganizations(data);
    setFallbackOrganization((current) => (data.some((o) => o.id === current) ? current : data[0]?.id || ''));
  }, []);
  const loadData = useCallback(async (id: string) => {
    const query = `?organizationId=${encodeURIComponent(id)}`;
    const [nextCustomers, nextDocuments, nextCatalog, nextFormats, nextProducts] = await Promise.all([
      api<Customer[]>(`/customers${query}`),
      api<BusinessDocument[]>(`/documents${query}`),
      api<CatalogItem[]>(`/catalog${query}`),
      api<InvoiceFormat[]>(`/formats${query}`),
      api<BusinessProduct[]>(`/business-products${query}`),
    ]);
    if (currentOrganization.current !== id) return;
    setCustomers(nextCustomers);
    setDocuments(nextDocuments);
    setCatalog(nextCatalog);
    setFormats(nextFormats);
    setBusinessProducts(nextProducts);
    setLoadedOrganization(id);
  }, []);
  useEffect(() => {
    loadOrganizations()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [loadOrganizations]);
  useEffect(() => {
    if (!organizationId || loading || !organization) return;
    localStorage.setItem('vc-organization', organizationId);
    let cancelled = false;
    setLoadingData(true);
    setCustomers([]);
    setDocuments([]);
    setCatalog([]);
    setFormats([]);
    setBusinessProducts([]);
    setError('');
    const query = `?organizationId=${encodeURIComponent(organizationId)}`;
    Promise.all([
      api<Customer[]>(`/customers${query}`),
      api<BusinessDocument[]>(`/documents${query}`),
      api<CatalogItem[]>(`/catalog${query}`),
      api<InvoiceFormat[]>(`/formats${query}`),
      api<BusinessProduct[]>(`/business-products${query}`),
    ])
      .then(([c, d, items, savedFormats, products]) => {
        if (!cancelled) {
          setCustomers(c);
          setDocuments(d);
          setCatalog(items);
          setFormats(savedFormats);
          setBusinessProducts(products);
          setLoadedOrganization(organizationId);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingData(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, loading, Boolean(organization)]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    setSearch('');
    setStatusFilter('all');
    setProductFilter('all');
  }, [organizationId]);

  const invoices = documents.filter((d) => d.kind === 'invoice');
  const quotations = documents.filter((d) => d.kind === 'quotation');
  const invoiceTotal = invoices.reduce((sum, d) => sum + paidAmount(d), 0);
  const outstanding = invoices
    .filter((d) => ['sent', 'partially_paid'].includes(d.status))
    .reduce((sum, d) => sum + balanceDue(d), 0);
  const scheduledDues = invoices
    .filter((d) => d.installmentPlan && d.status !== 'cancelled' && d.status !== 'draft')
    .flatMap((doc) =>
      installmentBalances(doc, today())
        .filter((row) => row.balanceDue > 0)
        .map((row) => ({ ...row, document: doc })),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const installmentOverdue = scheduledDues
    .filter((row) => row.status === 'overdue')
    .reduce((sum, row) => sum + row.balanceDue, 0);
  const activeQuotes = quotations.filter((d) => d.status === 'draft' || d.status === 'sent');
  const overdue = invoices.filter((d) => statusOf(d) === 'overdue');
  const filteredDocuments = useMemo(
    () =>
      documents
        .filter(
          (d) =>
            (!documentViews[view] || d.kind === documentViews[view]) &&
            (productFilter === 'all' || d.businessProductId === productFilter) &&
            (statusFilter === 'all' || statusOf(d) === statusFilter || d.status === statusFilter) &&
            `${d.number} ${d.customerSnapshot.name} ${d.title} ${d.businessProductSnapshot?.name || ''}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [documents, search, statusFilter, productFilter, view],
  );
  const selectedDocument = route?.id
    ? documents.find(
        (doc) =>
          doc.id === route.id && doc.organizationId === organizationId && doc.kind === documentViews[view],
      )
    : undefined;
  const documentKind = documentViews[view];
  const editor: Editor =
    documentKind && (route?.action === 'new' || (route?.action === 'edit' && selectedDocument))
      ? {
          type: 'document',
          kind: documentKind,
          document: selectedDocument,
          draft: draftCache.current.get(draftKey(organizationId, documentKind, selectedDocument?.id)),
        }
      : view === 'business_settings'
        ? { type: 'organization', organization }
        : view === 'organizations' && route?.action === 'new'
          ? { type: 'organization' }
          : view === 'organizations' &&
              route?.action === 'edit' &&
              organizations.some((org) => org.id === route.id)
            ? { type: 'organization', organization: organizations.find((org) => org.id === route.id) }
            : view === 'customers' && route?.action === 'new' && pendingDocument
              ? { type: 'customer' }
              : null;
  const preview = route?.action === 'preview' ? selectedDocument : undefined;
  const paymentDocument = route?.action === 'payments' ? selectedDocument : undefined;
  const messagingDocument = route?.action === 'email' ? selectedDocument : undefined;
  const dashboardEditor = view === 'dashboard_branding';
  const help = view === 'help';
  const confirmDelete =
    route?.action === 'delete' && selectedDocument
      ? { type: 'document' as const, id: selectedDocument.id, name: selectedDocument.number }
      : null;
  const adminPage =
    ['business_settings', 'dashboard_branding', 'team', 'integrations'].includes(view) ||
    (view === 'organizations' && Boolean(route?.action));
  const pageDenied = adminPage && !isAdmin;
  const pageMissing =
    view === 'not_found' ||
    Boolean(documentKind && route?.action !== 'new' && route?.action && !selectedDocument) ||
    Boolean(view === 'organizations' && route?.action === 'edit' && !editor);
  const managerPage =
    route?.action && ['customers', 'catalog', 'formats', 'business_products'].includes(view)
      ? (route as ManagerPage)
      : null;
  const isDetailPage = Boolean(
    editor ||
    preview ||
    paymentDocument ||
    messagingDocument ||
    dashboardEditor ||
    help ||
    confirmDelete ||
    pageDenied ||
    pageMissing,
  );
  const move = (next: WorkspaceRoute, replace = false) => {
    routeNavigate(next, replace);
    setMobileNav(false);
    setError('');
  };
  const navigate = (next: View) => {
    move({ organizationId, view: next });
    setPendingDocument(null);
    setSearch('');
    setStatusFilter('all');
  };
  const setOrganizationId = (id: string) => {
    setFallbackOrganization(id);
    move({ organizationId: id, view: 'overview' });
  };
  const chooseOrganization = (id: string) => {
    setPendingDocument(null);
    setOrganizationId(id);
  };
  const documentRoute = (
    document: BusinessDocument,
    action: WorkspaceRoute['action'] = 'preview',
  ): WorkspaceRoute => ({
    organizationId: document.organizationId,
    view: documentListFor[document.kind],
    action,
    id: document.id,
  });
  const setPreview = (doc: BusinessDocument | null) =>
    doc ? move(documentRoute(doc)) : move({ organizationId, view });
  const setPaymentDocument = (doc: BusinessDocument | null) =>
    doc
      ? move(documentRoute(doc, 'payments'))
      : selectedDocument
        ? move(documentRoute(selectedDocument))
        : navigate('invoices');
  const setMessagingDocument = (doc: BusinessDocument | null) =>
    doc
      ? move(documentRoute(doc, 'email'))
      : selectedDocument
        ? move(documentRoute(selectedDocument))
        : navigate('invoices');
  const setDashboardEditor = (open: boolean) => navigate(open ? 'dashboard_branding' : 'overview');
  const setHelp = (open: boolean) => navigate(open ? 'help' : 'overview');
  const setConfirmDelete = (target: { type: 'customer' | 'document'; id: string; name: string } | null) =>
    target ? move({ organizationId, view, action: 'delete', id: target.id }) : move({ organizationId, view });
  const setEditor = (next: Editor) => {
    if (!next) {
      if (selectedDocument) move(documentRoute(selectedDocument));
      else move({ organizationId, view: view === 'business_settings' ? 'organizations' : view });
      return;
    }
    if (next.type === 'document') {
      if (next.draft)
        draftCache.current.set(draftKey(organizationId, next.kind, next.document?.id), next.draft);
      move({
        organizationId,
        view: documentListFor[next.kind],
        action: next.document ? 'edit' : 'new',
        id: next.document?.id,
      });
    } else if (next.type === 'customer')
      move({
        organizationId,
        view: 'customers',
        action: next.customer ? 'edit' : 'new',
        id: next.customer?.id,
      });
    else
      move({
        organizationId,
        view: next.organization?.id === organizationId ? 'business_settings' : 'organizations',
        ...(next.organization?.id === organizationId
          ? {}
          : { action: next.organization ? 'edit' : 'new', id: next.organization?.id }),
      });
  };
  const newDocument = (kind: DocumentKind) => setEditor({ type: 'document', kind });
  const openManagerPage = (page: ManagerPage | null) => move({ organizationId, view, ...(page || {}) });
  useEffect(() => {
    if (!loading && organization && !route) routeNavigate({ organizationId, view: 'overview' }, true);
  }, [loading, organization, organizationId, route, routeNavigate]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('.main-content h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [route?.organizationId, route?.view, route?.action, route?.id, loadingData]);
  async function saveDocument(input: DocumentInput, id?: string) {
    const saved = await api<BusinessDocument>(
      id ? `/documents/${id}` : '/documents',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    setDocuments((current) => [saved, ...current.filter((d) => d.id !== saved.id)]);
    draftCache.current.delete(draftKey(saved.organizationId, saved.kind, id));
    move(documentRoute(saved), true);
    setToast(`${DOCUMENT_LABELS[input.kind]} ${id ? 'updated' : 'saved'}`);
  }
  async function saveCustomer(input: Omit<Customer, 'id'>, id?: string) {
    const saved = await api<Customer>(
      id ? `/customers/${id}` : '/customers',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    setCustomers((current) => [saved, ...current.filter((c) => c.id !== saved.id)]);
    if (pendingDocument) {
      let draft = pendingDocument.draft;
      if (draft) {
        const shipping = { ...blankShipping(), ...draft.shipping };
        const previous = customers.find((contact) => contact.id === draft?.customerId);
        const previousShipping = previous && {
          recipientName: previous.name,
          address: previous.shippingAddress || previous.address,
          stateCode: previous.shippingStateCode || previous.stateCode,
          phone: previous.phone,
        };
        const inheritedShipping =
          previousShipping &&
          Object.entries(previousShipping).every(
            ([key, value]) => shipping[key as keyof typeof shipping] === value,
          );
        if (!shipping.address || inheritedShipping)
          Object.assign(shipping, {
            recipientName: saved.name,
            address: saved.shippingAddress || saved.address,
            stateCode: saved.shippingStateCode || saved.stateCode,
            phone: saved.phone,
          });
        let dueDate = draft.dueDate;
        if (!pendingDocument.document && pendingDocument.kind !== 'delivery_note' && saved.paymentTermsDays) {
          const due = new Date(`${draft.issueDate}T12:00:00Z`);
          if (Number.isFinite(due.getTime())) {
            due.setUTCDate(due.getUTCDate() + saved.paymentTermsDays);
            dueDate = due.toISOString().slice(0, 10);
          }
        }
        draft = {
          ...draft,
          customerId: saved.id,
          placeOfSupply: saved.stateCode || draft.placeOfSupply,
          shipping,
          dueDate,
        };
      }
      setEditor({ ...pendingDocument, draft });
      setPendingDocument(null);
    } else setEditor(null);
    setToast(id ? 'Contact updated' : 'Contact saved');
  }
  async function saveContact(input: Omit<Customer, 'id'>, id?: string) {
    const saved = await api<Customer>(
      id ? `/customers/${id}` : '/customers',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    if (currentOrganization.current === saved.organizationId)
      setCustomers((current) => [saved, ...current.filter((contact) => contact.id !== saved.id)]);
  }
  async function saveOrganization(input: Omit<Organization, 'id'>, id?: string) {
    const data = await api<Organization>(
      id ? `/organizations/${id}` : '/organizations',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    setOrganizations((current) =>
      id ? current.map((org) => (org.id === id ? data : org)) : [...current, data],
    );
    setFallbackOrganization(data.id);
    move({ organizationId: data.id, view: 'organizations' }, true);
    setToast(id ? 'Organization settings saved' : 'Organization created');
  }
  async function convert(doc: BusinessDocument) {
    const result = await api<BusinessDocument>(`/documents/${doc.id}/convert`, sendJson('POST'));
    setDocuments((current) => [
      result,
      ...current
        .filter((d) => d.id !== result.id)
        .map((d) =>
          d.id === doc.id ? { ...d, status: 'accepted' as const, convertedInvoiceId: result.id } : d,
        ),
    ]);
    setPreview(result);
    setToast(`${DOCUMENT_LABELS[doc.kind]} converted to invoice`);
  }
  async function createDeliveryNote(doc: BusinessDocument) {
    const result = await api<BusinessDocument>(`/documents/${doc.id}/delivery-note`, sendJson('POST'));
    setDocuments((current) => [
      result,
      ...current
        .filter((d) => d.id !== result.id)
        .map((d) => (d.id === doc.id ? { ...d, deliveryNoteId: result.id } : d)),
    ]);
    setPreview(result);
    setToast('Delivery challan ready');
  }
  function paymentUpdated(doc: BusinessDocument) {
    setDocuments((current) => current.map((d) => (d.id === doc.id ? doc : d)));
  }
  async function saveBusinessProduct(input: BusinessProductInput, id?: string) {
    const saved = await api<BusinessProduct>(
      id ? `/business-products/${id}` : '/business-products',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    if (currentOrganization.current === saved.organizationId)
      setBusinessProducts((current) => [...current.filter((product) => product.id !== saved.id), saved]);
    setToast(saved.active ? 'Business product saved' : 'Business product archived');
  }
  async function saveWorkspaceSettings(input: WorkspaceSettings) {
    const saved = await api<WorkspaceSettings>('/workspace-settings', sendJson('PUT', input));
    setWorkspaceSettings(saved);
    setToast('Workspace branding saved');
  }
  async function saveCatalog(input: CatalogInput, id?: string) {
    const saved = await api<CatalogItem>(
      id ? `/catalog/${id}` : '/catalog',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    if (currentOrganization.current === saved.organizationId)
      setCatalog((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setToast(saved.active ? `${saved.type === 'service' ? 'Service' : 'Product'} saved` : 'Item archived');
  }
  async function saveFormat(input: FormatInput, id?: string) {
    const saved = await api<InvoiceFormat>(
      id ? `/formats/${id}` : '/formats',
      sendJson(id ? 'PUT' : 'POST', input),
    );
    if (currentOrganization.current === saved.organizationId)
      setFormats((current) => [
        ...current
          .filter((format) => format.id !== saved.id)
          .map((format) => (saved.isDefault ? { ...format, isDefault: false } : format)),
        saved,
      ]);
    setToast(saved.isDefault ? 'Default invoice format saved' : 'Invoice format saved');
  }
  async function deleteFormat(id: string) {
    const requestedOrganization = organizationId;
    await api(`/formats/${id}`, sendJson('DELETE'));
    if (currentOrganization.current === requestedOrganization)
      setFormats((current) => current.filter((format) => format.id !== id));
    setToast('Format deleted. Saved documents keep their design.');
  }
  function exportCsv() {
    const rows = [
      [
        'Number',
        'Type',
        'Business product',
        'Customer',
        'Date',
        'Due date',
        'Status',
        'Taxable (INR)',
        'GST (INR)',
        'Total (INR)',
        'Received (INR)',
        'Balance (INR)',
        'Finalized',
      ],
      ...filteredDocuments.map((d) => [
        d.number,
        d.kind,
        d.businessProductSnapshot?.name || '',
        d.customerSnapshot.name,
        d.issueDate,
        d.dueDate,
        statusOf(d),
        d.totals.taxable,
        d.totals.cgst + d.totals.sgst + d.totals.igst,
        d.kind === 'delivery_note' ? '' : d.totals.total,
        paidAmount(d),
        balanceDue(d),
        d.finalizedAt || '',
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((value) => {
            let s = String(value);
            if (/^\s*[=+@-]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${organization?.name.toLowerCase().replace(/\W+/g, '-')}-${view}-${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast('CSV exported');
  }

  function renderDocumentTable(recent = false) {
    const rows = recent ? filteredDocuments.slice(0, 5) : filteredDocuments;
    return (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>DOCUMENT / CUSTOMER</th>
              <th>DATE</th>
              <th>AMOUNT</th>
              <th>STATUS</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((doc) => (
              <tr key={doc.id} onClick={() => setPreview(doc)}>
                <td>
                  <div className="document-cell">
                    <span className={`file-icon ${doc.kind}`}>
                      <FileText size={18} />
                    </span>
                    <div>
                      <button
                        className="text-button document-number"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreview(doc);
                        }}
                      >
                        {doc.number}
                      </button>
                      <span>{doc.customerSnapshot.name}</span>
                      {doc.businessProductSnapshot && (
                        <small className="document-product-name">{doc.businessProductSnapshot.name}</small>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {displayDate(doc.issueDate)}
                  <small>
                    {doc.kind === 'delivery_note'
                      ? 'Dispatch'
                      : doc.kind === 'invoice'
                        ? 'Due'
                        : 'Valid until'}{' '}
                    {displayDate(
                      doc.kind === 'delivery_note' ? doc.shipping?.dispatchDate || '' : doc.dueDate,
                    )}
                  </small>
                </td>
                <td className="amount">
                  {doc.kind === 'delivery_note'
                    ? `${doc.items.reduce((sum, item) => sum + item.quantity, 0)} qty`
                    : money(doc.totals.total)}
                  <small>
                    {DOCUMENT_LABELS[doc.kind]}
                    {paidAmount(doc) > 0 && doc.status !== 'paid' ? ` · ${money(balanceDue(doc))} due` : ''}
                  </small>
                </td>
                <td>
                  <span className={`status ${statusOf(doc)}`}>
                    {doc.finalizedAt ? <LockKeyhole size={11} /> : <i />}
                    {doc.finalizedAt ? 'Paid / Final' : statusLabel(statusOf(doc))}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      title="View document"
                      aria-label={`View ${doc.number}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreview(doc);
                      }}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                    {doc.kind === 'invoice' && doc.status !== 'cancelled' && (
                      <button
                        className="icon-button"
                        aria-label={`Payments for ${doc.number}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPaymentDocument(doc);
                        }}
                      >
                        <Wallet size={16} />
                      </button>
                    )}
                    {doc.status === 'draft' &&
                      !doc.convertedInvoiceId &&
                      !doc.sourceQuotationId &&
                      !doc.sourceDocumentId &&
                      !doc.deliveryNoteId &&
                      !paidAmount(doc) && (
                        <button
                          className="icon-button delete-action"
                          aria-label={`Delete ${doc.number}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete({ type: 'document', id: doc.id, name: doc.number });
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="empty-state">
            <div className="empty-document">
              <FileText size={31} />
              <span className="empty-plus">
                <Plus size={13} />
              </span>
            </div>
            <h3>
              {search || statusFilter !== 'all'
                ? 'No matching documents'
                : recent
                  ? 'Your next chapter starts here'
                  : view === 'quotations'
                    ? 'Turn possibilities into proposals'
                    : 'Let’s make your first invoice'}
            </h3>
            <p>
              {search || statusFilter !== 'all'
                ? 'Try a different search or status filter.'
                : 'Create a document and keep every detail in one place.'}
            </p>
            {!search && statusFilter === 'all' && (
              <button
                className="text-button green"
                onClick={() => newDocument(documentViews[view] || 'invoice')}
              >
                Create {DOCUMENT_LABELS[documentViews[view] || 'invoice'].toLowerCase()}{' '}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (loading)
    return (
      <div className="boot-screen">
        <div className="brand-symbol">
          v<span>c</span>
          <i />
        </div>
        <LoaderCircle size={24} className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!organization && organizations.length)
    return (
      <div className="boot-screen">
        <Building2 size={32} />
        <h1>Organization unavailable</h1>
        <p>This organization is not available to your account.</p>
        <button className="button primary" onClick={() => chooseOrganization(organizations[0].id)}>
          Open your workspace
        </button>
        <button className="button secondary" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    );
  if (!organization)
    return (
      <div className="boot-screen">
        <Building2 size={32} />
        <h2>{isAdmin ? 'Let’s get your workspace ready' : 'Your organization access is being set up'}</h2>
        <p>
          {error ||
            (isAdmin
              ? 'Add your first organization to get started.'
              : 'Ask your administrator to assign an organization to your account, then log in again.')}
        </p>
        {error && (
          <button
            className="button secondary"
            onClick={() => loadOrganizations().catch((err) => setError(err.message))}
          >
            Try again
          </button>
        )}
        {isAdmin && !error && (
          <button className="button primary" onClick={() => setEditor({ type: 'organization' })}>
            Create organization
          </button>
        )}
        <button className="button secondary" onClick={() => void logout()} disabled={loggingOut}>
          <LogOut size={16} />
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
        {isAdmin && editor?.type === 'organization' && (
          <OrganizationEditor onClose={() => setEditor(null)} onSave={saveOrganization} />
        )}
      </div>
    );
  const titles = {
    overview: 'Workspace overview',
    invoices: 'Invoices',
    quotations: 'Quotations',
    proformas: 'Proforma invoices',
    shipping: 'Shipping & delivery',
    customers: 'Contacts',
    organizations: 'Organizations',
    catalog: 'Products & services',
    formats: 'Invoice formats',
    business_products: 'Business products',
    team: 'Team & access',
    integrations: 'Payments & email',
    business_settings: 'Business settings',
    dashboard_branding: 'Dashboard branding',
    help: 'Help & getting started',
    not_found: 'Page not found',
  };
  const subtitles = {
    overview: 'A little clarity for your business, every day.',
    invoices: 'Create, preview, print and download every invoice.',
    quotations: 'From a good conversation to a great proposal.',
    proformas: 'Confirm your scope before the tax invoice.',
    shipping: 'Dispatch notes, delivery challans and shipment details.',
    customers: 'Customers, vendors and B2B buyers for each organization.',
    organizations: 'Venturecore divisions and independent businesses, each with its own records.',
    catalog: 'Your offerings, prices and tax details—ready to use.',
    formats: 'Design it your way. Save a format for every kind of work.',
    business_products: 'Choose which product your next invoice belongs to.',
    team: 'Approve accounts and assign organization access.',
    integrations: 'Payment collection and customer email setup.',
    business_settings: 'Legal identity, GST and payment details.',
    dashboard_branding: 'Your workspace identity.',
    help: 'Make the most of your workspace.',
    not_found: 'This page is unavailable.',
  };
  return (
    <>
      <div className={`app-shell ${mobileNav ? 'navigation-open' : ''}`}>
        <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
          <a
            className="brand"
            href={workspaceUrl({ organizationId, view: 'overview' })}
            aria-label={`${organization.name} overview`}
            onClick={(e) => {
              e.preventDefault();
              navigate('overview');
            }}
          >
            <div className="brand-symbol organization-mark" style={{ color: organization.accentColor }}>
              {organization.logoUrl ? <img src={organization.logoUrl} alt="" /> : initials(organization.name)}
            </div>
            <div className="organization-brand-name">
              {organization.name}
              <span>BUSINESS WORKSPACE</span>
            </div>
          </a>
          <div className="organization-picker">
            <label className="sidebar-eyebrow" htmlFor="workspace-organization">
              YOUR ORGANIZATION
            </label>
            <select
              id="workspace-organization"
              className="organization-select"
              value={organizationId}
              onChange={(event) => chooseOrganization(event.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
            <span className="organization-relationship">
              {isIndependentBusiness(organization) ? 'Independent business' : 'Venturecore division'}
            </span>
            {isAdmin && (
              <button
                className="text-button add-org-link"
                onClick={() => setEditor({ type: 'organization' })}
              >
                <Plus size={14} />
                Add organization
              </button>
            )}
          </div>
          <div className="sidebar-eyebrow nav-label">WORKSPACE</div>
          <nav className="main-nav" aria-label="Main navigation">
            <button className={view === 'overview' ? 'active' : ''} onClick={() => navigate('overview')}>
              <LayoutDashboard size={19} />
              Overview
              <span className="active-dot" />
            </button>
            <button className={view === 'invoices' ? 'active' : ''} onClick={() => navigate('invoices')}>
              <ReceiptText size={19} />
              Invoices{invoices.length > 0 && <span className="nav-count">{invoices.length}</span>}
            </button>
            <button className={view === 'quotations' ? 'active' : ''} onClick={() => navigate('quotations')}>
              <FileText size={19} />
              Quotations{quotations.length > 0 && <span className="nav-count">{quotations.length}</span>}
            </button>
            <button className={view === 'proformas' ? 'active' : ''} onClick={() => navigate('proformas')}>
              <BriefcaseBusiness size={19} />
              Proforma invoices
            </button>
            <button className={view === 'shipping' ? 'active' : ''} onClick={() => navigate('shipping')}>
              <Truck size={19} />
              Shipping & delivery
            </button>
            <button className={view === 'customers' ? 'active' : ''} onClick={() => navigate('customers')}>
              <UsersRound size={19} />
              Contacts
            </button>
            <button className={view === 'catalog' ? 'active' : ''} onClick={() => navigate('catalog')}>
              <Package size={19} />
              Products & services
              {catalog.filter((item) => item.active).length > 0 && (
                <span className="nav-count">{catalog.filter((item) => item.active).length}</span>
              )}
            </button>
          </nav>
          {(organization.enableProductSelection || businessProducts.length > 0) && (
            <nav className="main-nav">
              <button
                className={view === 'business_products' ? 'active' : ''}
                onClick={() => navigate('business_products')}
              >
                <Layers3 size={19} />
                Business products
                <span className="nav-count">{businessProducts.filter((p) => p.active).length}</span>
              </button>
            </nav>
          )}
          <div className="sidebar-eyebrow nav-label manage-label">MANAGE</div>
          <nav className="main-nav">
            <button className={view === 'formats' ? 'active' : ''} onClick={() => navigate('formats')}>
              <PanelsTopLeft size={19} />
              Invoice formats
            </button>
            <button
              className={view === 'organizations' ? 'active' : ''}
              onClick={() => navigate('organizations')}
            >
              <Layers3 size={19} />
              Organizations<span className="nav-count">{organizations.length}</span>
            </button>
            {isAdmin && (
              <>
                <button onClick={() => setEditor({ type: 'organization', organization })}>
                  <Settings2 size={19} />
                  Business settings
                </button>
                <button onClick={() => setDashboardEditor(true)}>
                  <Building2 size={19} />
                  Dashboard branding
                </button>
                <button className={view === 'team' ? 'active' : ''} onClick={() => navigate('team')}>
                  <UsersRound size={19} />
                  Team &amp; access
                </button>
                <button
                  className={view === 'integrations' ? 'active' : ''}
                  onClick={() => navigate('integrations')}
                >
                  <PlugZap size={19} />
                  Payments &amp; email
                </button>
              </>
            )}
          </nav>
          <div className="sidebar-bottom">
            <div className="workspace-note">
              <div className="note-icon">
                <Sparkles size={19} />
              </div>
              <h4>Made for your next move.</h4>
              <p>
                One workspace for everything
                <br />
                that moves your business forward.
              </p>
              <button onClick={() => setHelp(true)}>
                Explore your workspace <ArrowUpRight size={14} />
              </button>
            </div>
            <button className="support-button" onClick={() => setHelp(true)}>
              <CircleHelp size={18} />
              Help & getting started
              <ArrowUpRight size={14} />
            </button>
            <div className="profile">
              <div className="profile-avatar">
                {organization.logoUrl ? (
                  <img src={organization.logoUrl} alt="" />
                ) : (
                  initials(organization.name)
                )}
              </div>
              <div>
                {user.name}
                <span>{isAdmin ? 'Administrator' : 'Organization team'}</span>
              </div>
              <button
                className="icon-button"
                aria-label="Log out"
                title="Log out"
                disabled={loggingOut}
                onClick={() => void logout()}
              >
                {loggingOut ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label={mobileNav ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileNav}
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={22} />
            </button>
            <div className="breadcrumb">
              <span className="breadcrumb-organization" title={organization.name}>
                {organization.name}
              </span>
              <ChevronRight size={14} />
              <strong>{titles[view].replace('Workspace ', '')}</strong>
            </div>
            <div className="topbar-right">
              <span className="currency-badge">
                <span className="india-flag">🇮🇳</span> India <span>·</span> INR
              </span>
              <div className="topbar-divider" />
              <button
                className="topbar-avatar"
                aria-label={isAdmin ? 'Open dashboard branding' : 'Log out'}
                disabled={loggingOut}
                onClick={() => (isAdmin ? setDashboardEditor(true) : void logout())}
              >
                {organization.logoUrl ? (
                  <img src={organization.logoUrl} alt="" />
                ) : (
                  initials(organization.name)
                )}
              </button>
            </div>
          </header>
          <main className="main-content" id="main-content">
            {toast && (
              <div className="page-notice" role="status">
                <Check size={17} />
                {toast}
                <button
                  className="icon-button"
                  onClick={() => setToast('')}
                  aria-label="Dismiss notification"
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {!isDetailPage && !managerPage && view !== 'formats' && (
              <div className="page-heading">
                <div>
                  <div className="page-eyebrow">{organization.name.toUpperCase()}</div>
                  <h1 tabIndex={-1}>
                    {titles[view]}
                    <span className="heading-dot">.</span>
                  </h1>
                  <p>{subtitles[view]}</p>
                </div>
                <div className="heading-actions">
                  {view === 'overview' ? (
                    <>
                      <button className="button secondary" onClick={() => newDocument('quotation')}>
                        <Plus size={16} />
                        New quotation
                      </button>
                      <button className="button primary" onClick={() => newDocument('invoice')}>
                        <Plus size={16} />
                        New invoice
                      </button>
                    </>
                  ) : view === 'organizations' ? (
                    isAdmin ? (
                      <button className="button primary" onClick={() => setEditor({ type: 'organization' })}>
                        <Plus size={16} />
                        New organization
                      </button>
                    ) : null
                  ) : ['customers', 'catalog', 'business_products', 'team', 'integrations'].includes(
                      view,
                    ) ? null : (
                    <>
                      <button className="button secondary" onClick={exportCsv}>
                        <ArrowDownToLine size={16} />
                        Export
                      </button>
                      <button
                        className="button primary"
                        onClick={() => newDocument(documentViews[view] || 'invoice')}
                      >
                        <Plus size={16} />
                        New {DOCUMENT_LABELS[documentViews[view] || 'invoice'].toLowerCase()}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="page-error" role="alert">
                {error}
                <button
                  onClick={() => {
                    setError('');
                    loadData(organizationId).catch((err) => setError(err.message));
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            {loadingData || loadedOrganization !== organizationId ? (
              <div className="data-loading">
                <LoaderCircle className="spin" size={25} />
                <span>Loading {organization.name}…</span>
              </div>
            ) : pageDenied || pageMissing ? (
              <section className="workspace-page unavailable-page">
                <h1 tabIndex={-1}>{pageDenied ? 'Access unavailable' : 'Page not found'}</h1>
                <p>
                  {pageDenied
                    ? 'Your account does not have access to this page.'
                    : 'This page or record is unavailable in the selected organization.'}
                </p>
                <button className="button secondary" onClick={() => navigate('overview')}>
                  <ArrowLeft size={16} />
                  Back to overview
                </button>
              </section>
            ) : isDetailPage ? (
              <>
                {' '}
                {dashboardEditor && isAdmin && (
                  <WorkspaceSettingsEditor
                    key={organizationId}
                    settings={workspaceSettings}
                    organization={organization}
                    onEditOrganization={() => setEditor({ type: 'organization', organization })}
                    onClose={() => setDashboardEditor(false)}
                    onSave={saveWorkspaceSettings}
                  />
                )}
                {editor?.type === 'customer' && (
                  <CustomerEditor
                    invoiceRecipientOnly
                    organizationId={organizationId}
                    customer={editor.customer}
                    onClose={() => {
                      setEditor(pendingDocument);
                      setPendingDocument(null);
                    }}
                    onSave={saveCustomer}
                  />
                )}
                {isAdmin && editor?.type === 'organization' && (
                  <OrganizationEditor
                    companyDefaults={companyDefaults}
                    organization={editor.organization}
                    onClose={() => setEditor(null)}
                    onSave={saveOrganization}
                  />
                )}
                {editor?.type === 'document' && (
                  <DocumentEditor
                    key={draftKey(organizationId, editor.kind, editor.document?.id)}
                    organization={organization}
                    customers={customers.filter(
                      (contact) => isInvoiceRecipient(contact) || contact.id === editor.document?.customerId,
                    )}
                    catalog={catalog}
                    businessProducts={businessProducts}
                    formats={formats}
                    kind={editor.kind}
                    document={editor.document}
                    initialDraft={editor.draft}
                    onClose={() => setEditor(null)}
                    onSave={saveDocument}
                    onDraftChange={(draft) =>
                      draftCache.current.set(
                        draftKey(organizationId, editor.kind, editor.document?.id),
                        draft,
                      )
                    }
                    onManageCatalog={(draft) => {
                      setPendingDocument({ ...editor, draft });
                      move({ organizationId, view: 'catalog' });
                    }}
                    onManageFormats={(draft) => {
                      setPendingDocument({ ...editor, draft });
                      move({ organizationId, view: 'formats' });
                    }}
                    onAddCustomer={(draft) => {
                      setPendingDocument({ ...editor, draft });
                      setEditor({ type: 'customer' });
                    }}
                  />
                )}
                {preview && (
                  <DocumentPreview
                    document={preview}
                    onEmail={() => setMessagingDocument(preview)}
                    onClose={() => setPreview(null)}
                    onEdit={() => setEditor({ type: 'document', kind: preview.kind, document: preview })}
                    onConvert={
                      ['quotation', 'proforma'].includes(preview.kind) ? () => convert(preview) : undefined
                    }
                    onPayments={preview.kind === 'invoice' ? () => setPaymentDocument(preview) : undefined}
                    onCreateDeliveryNote={
                      preview.kind === 'invoice' ? () => createDeliveryNote(preview) : undefined
                    }
                  />
                )}
                {messagingDocument && (
                  <MessagingPanel document={messagingDocument} onClose={() => setMessagingDocument(null)} />
                )}
                {paymentDocument && (
                  <PaymentPanel
                    document={paymentDocument}
                    onClose={() => setPaymentDocument(null)}
                    onUpdated={paymentUpdated}
                  />
                )}
                {help && (
                  <div className="workspace-page">
                    <section className="help-page" aria-labelledby="help-title">
                      <div className="page-panel-heading">
                        <div className="page-panel-icon">
                          <Sparkles size={23} />
                        </div>
                        <div>
                          <h1 tabIndex={-1} id="help-title">
                            A place for your business to grow
                          </h1>
                          <p>Your workspace, in four simple steps.</p>
                        </div>
                        <button
                          className="button secondary"
                          aria-label="Back from help"
                          onClick={() => setHelp(false)}
                        >
                          <ArrowLeft size={16} />
                          Back
                        </button>
                      </div>
                      <div className="help-steps">
                        {[
                          [
                            '01',
                            'Make yourself at home',
                            'Choose your organization, then save its legal identity, GST registrations, support address, bank details, QR and branding in Business settings. Shri Sarraf has its own independent business details.',
                          ],
                          [
                            '02',
                            'Save your connections',
                            'Save customers, B2B buyers and vendors for this organization. Search and select them directly while creating documents, or fetch their details with a GSTIN. Review fetched details before saving.',
                          ],
                          [
                            '03',
                            'Put your proposal on paper',
                            'Save products and services in the catalog, choose an invoice format, then create a quotation. Convert it into an invoice when you’re ready.',
                          ],
                          [
                            '04',
                            'Keep things moving',
                            'Add shipping details or create a delivery challan. Record each payment: full payment makes the same invoice Paid / Final and locks editing. Preview, print and download any document. Saved documents retain their company, customer and design details.',
                          ],
                        ].map(([n, title, description]) => (
                          <div className="help-step" key={n}>
                            <span>{n}</span>
                            <div>
                              <h3>{title}</h3>
                              <p>{description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="page-panel-footer">
                        {organizationSupportEmail(organization) && (
                          <a
                            className="text-button green"
                            href={`mailto:${organizationSupportEmail(organization)}`}
                          >
                            {organizationSupportEmail(organization)}
                          </a>
                        )}
                        <button
                          className="button primary"
                          onClick={() => {
                            if (isAdmin) setEditor({ type: 'organization', organization });
                            else navigate('customers');
                          }}
                        >
                          {isAdmin ? 'Set up this business' : 'Open contacts'} <ArrowRight size={16} />
                        </button>
                      </div>
                    </section>
                  </div>
                )}
                {confirmDelete && (
                  <div className="workspace-page">
                    <section className="confirmation-page" aria-labelledby="delete-title">
                      <div className="page-panel-body">
                        <div className="delete-symbol">
                          <Trash2 size={24} />
                        </div>
                        <h1 tabIndex={-1} id="delete-title">
                          Delete draft?
                        </h1>
                        <p>
                          <strong>{confirmDelete.name}</strong> will be removed. This cannot be undone.
                        </p>
                        <p className="field-hint">
                          Customers used in a document and linked quotations/invoices cannot be deleted.
                        </p>
                      </div>
                      <div className="page-panel-footer">
                        <button
                          className="button secondary"
                          disabled={deleting}
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="button danger"
                          disabled={deleting}
                          onClick={async () => {
                            setDeleting(true);
                            try {
                              await api(`/documents/${confirmDelete.id}`, sendJson('DELETE'));
                              await loadData(organizationId);
                              move({ organizationId, view }, true);
                              setToast('Deleted successfully');
                            } catch (err) {
                              setToast((err as Error).message);
                            } finally {
                              setDeleting(false);
                            }
                          }}
                        >
                          {deleting ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </section>
                  </div>
                )}
              </>
            ) : (
              <>
                {pendingDocument && ['catalog', 'formats', 'customers'].includes(view) && (
                  <div className="return-to-draft">
                    <p>Your invoice draft is kept while you work here.</p>
                    <button
                      className="button secondary"
                      onClick={() => {
                        setEditor(pendingDocument);
                        setPendingDocument(null);
                      }}
                    >
                      <ArrowLeft size={16} />
                      Return to document
                    </button>
                  </div>
                )}
                {view === 'overview' && (
                  <>
                    <section className="hero-banner">
                      <div className="hero-copy">
                        <span className="hero-kicker">
                          <span />
                          YOUR BUSINESS, IN GOOD ORDER
                        </span>
                        <h2>
                          Less paperwork.
                          <br />
                          More possibilities.
                        </h2>
                        <p>
                          From the first quotation to the final payment,
                          <br />
                          bring every detail together.
                        </p>
                        <button onClick={() => newDocument('invoice')}>
                          Let’s create something <ArrowRight size={16} />
                        </button>
                      </div>
                      <div className="hero-art" aria-hidden="true">
                        <div className="orbit orbit-one" />
                        <div className="orbit orbit-two" />
                        <div className="art-spark">✳</div>
                        <div className="art-paper">
                          <div className="art-paper-top">
                            <div className="art-mark organization-art-mark">
                              {organization.logoUrl ? (
                                <img src={organization.logoUrl} alt="" />
                              ) : (
                                initials(organization.name)
                              )}
                            </div>
                            <span>INVOICE</span>
                          </div>
                          <div className="art-line long" />
                          <div className="art-line short" />
                          <div className="art-paper-rule" />
                          <div className="art-row">
                            <i />
                            <b />
                          </div>
                          <div className="art-row">
                            <i />
                            <b />
                          </div>
                          <div className="art-row">
                            <i />
                            <b />
                          </div>
                          <div className="art-paper-total">
                            <span>
                              GOOD BUSINESS.
                              <br />
                              GREAT BEGINNINGS.
                            </span>
                            <div>
                              <Check size={15} />
                            </div>
                          </div>
                        </div>
                        <div className="art-check">
                          <Check size={29} strokeWidth={2.5} />
                        </div>
                        <div className="art-chip">
                          <Layers3 size={16} />
                          {organizations.length} organizations. One workspace.
                        </div>
                      </div>
                      <span className="hero-number">01 — MADE TO MOVE FORWARD</span>
                    </section>
                    <section className="stats-grid" aria-label="Organization metrics">
                      <Metric
                        label="TOTAL COLLECTED"
                        value={money(invoiceTotal)}
                        icon={<Wallet size={20} />}
                        hint={`${invoices.filter((d) => paidAmount(d) > 0).length} invoices with payments`}
                        variant="green"
                        onClick={() => navigate('invoices')}
                      />
                      <Metric
                        label="OUTSTANDING"
                        value={money(outstanding)}
                        icon={<ArrowDownLeft size={20} />}
                        hint={
                          overdue.length ? `${overdue.length} invoices overdue` : 'Keep an eye on what’s due'
                        }
                        variant="orange"
                        onClick={() => navigate('invoices')}
                      />
                      <Metric
                        label="OPEN QUOTATIONS"
                        value={String(activeQuotes.length).padStart(2, '0')}
                        icon={<FileText size={20} />}
                        hint={`${money(activeQuotes.reduce((sum, d) => sum + d.totals.total, 0))} in potential business`}
                        variant="purple"
                        onClick={() => navigate('quotations')}
                      />
                      <Metric
                        label="BUSINESS CONTACTS"
                        value={String(
                          customers.filter((contact) => contact.active !== false).length,
                        ).padStart(2, '0')}
                        icon={<UsersRound size={20} />}
                        hint="Relationships that matter"
                        variant="blue"
                        onClick={() => navigate('customers')}
                      />
                    </section>
                    {scheduledDues.length > 0 && (
                      <section className="emi-overview">
                        <div>
                          <span className="page-eyebrow">INSTALLMENT COLLECTIONS</span>
                          <h3>{scheduledDues.length} installments remaining</h3>
                          <p>
                            Overdue installments: <strong>{money(installmentOverdue)}</strong>
                          </p>
                        </div>
                        <button
                          className="button secondary"
                          onClick={() => setPaymentDocument(scheduledDues[0].document)}
                        >
                          Next: {displayDate(scheduledDues[0].dueDate)} · {money(scheduledDues[0].balanceDue)}
                          <ArrowRight size={15} />
                        </button>
                      </section>
                    )}
                    <div className="overview-grid">
                      <section className="panel recent-panel">
                        <div className="panel-heading">
                          <div>
                            <h2>Recent documents</h2>
                            <p>Your latest work, all in one place.</p>
                          </div>
                          <button className="text-button muted" onClick={() => navigate('invoices')}>
                            View invoices <ArrowRight size={15} />
                          </button>
                        </div>
                        {renderDocumentTable(true)}
                        <div className="panel-footnote">
                          <span className="small-dot" /> Showing activity for {organization.name}
                        </div>
                      </section>
                      <section className="panel quick-panel">
                        <div className="panel-heading">
                          <div>
                            <h2>Make your next move</h2>
                            <p>A few good places to start.</p>
                          </div>
                          <Sparkles size={18} />
                        </div>
                        <button className="quick-action" onClick={() => newDocument('quotation')}>
                          <span className="quick-icon purple">
                            <FilePlus2 size={21} />
                          </span>
                          <span>
                            <strong>Send a possibility</strong>
                            <small>Create a fresh quotation</small>
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                        <button className="quick-action" onClick={() => setEditor({ type: 'customer' })}>
                          <span className="quick-icon blue">
                            <UsersRound size={21} />
                          </span>
                          <span>
                            <strong>Add a connection</strong>
                            <small>Save customer, buyer or vendor details</small>
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                        <button className="quick-action" onClick={() => navigate('formats')}>
                          <span className="quick-icon orange">
                            <Settings2 size={21} />
                          </span>
                          <span>
                            <strong>Make it your own</strong>
                            <small>Customize your invoices</small>
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                        <div className="quick-tip">
                          <ShieldCheck size={18} />
                          <p>
                            Your work is saved.
                            <br />
                            <span>Every document, ready when you are.</span>
                          </p>
                        </div>
                      </section>
                    </div>
                    <div className="catalog-summary-strip">
                      <button onClick={() => navigate('catalog')}>
                        <Package size={24} />
                        <span>
                          <strong>Products &amp; services</strong>
                          <small>
                            {catalog.filter((item) => item.active).length} saved offerings · Ready for your
                            next document
                          </small>
                        </span>
                        <ArrowUpRight size={19} />
                      </button>
                      <button onClick={() => navigate('formats')}>
                        <PanelsTopLeft size={24} />
                        <span>
                          <strong>Your invoice, your format</strong>
                          <small>{formats.length} saved formats · Preview, print &amp; download</small>
                        </span>
                        <ArrowUpRight size={19} />
                      </button>
                    </div>
                    <section className="brands-section">
                      <div className="section-heading">
                        <div>
                          <h2>Every business, in its own space.</h2>
                          <p>Separate contacts, seller details and payment settings for each organization.</p>
                        </div>
                        <button className="text-button muted" onClick={() => navigate('organizations')}>
                          {isAdmin ? 'Manage organizations' : 'Your organizations'} <ArrowRight size={15} />
                        </button>
                      </div>
                      <div className="brand-cards">
                        {organizations.map((org) => (
                          <button
                            key={org.id}
                            className={`brand-card ${org.id === organizationId ? 'selected' : ''}`}
                            onClick={() => chooseOrganization(org.id)}
                          >
                            <span className="org-avatar" style={{ background: org.accentColor }}>
                              {org.logoUrl ? <img src={org.logoUrl} alt="" /> : initials(org.name)}
                            </span>
                            <strong>{org.name}</strong>
                            <span>
                              {org.id === organizationId ? (
                                <>
                                  <i className="small-dot" />
                                  Current workspace
                                </>
                              ) : (
                                <>
                                  Open workspace <ArrowUpRight size={12} />
                                </>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  </>
                )}
                {documentViews[view] && (
                  <>
                    <div className="list-summary">
                      <div>
                        <span>{view === 'shipping' ? 'DELIVERY CHALLANS' : 'DOCUMENT VALUE'}</span>
                        <strong>
                          {view === 'shipping'
                            ? filteredDocuments.length
                            : money(
                                documents
                                  .filter((d) => d.kind === documentViews[view] && d.status !== 'cancelled')
                                  .reduce((sum, d) => sum + d.totals.total, 0),
                              )}
                        </strong>
                      </div>
                      <div>
                        <span>{view === 'invoices' ? 'COLLECTED' : 'COMPLETED / ACCEPTED'}</span>
                        <strong>
                          {view === 'invoices'
                            ? money(invoiceTotal)
                            : documents.filter(
                                (d) =>
                                  d.kind === documentViews[view] &&
                                  ['accepted', 'delivered'].includes(d.status),
                              ).length}
                        </strong>
                      </div>
                      <div>
                        <span>{view === 'invoices' ? 'AWAITING PAYMENT' : 'DRAFTS'}</span>
                        <strong>
                          {view === 'invoices'
                            ? money(outstanding)
                            : documents.filter((d) => d.kind === documentViews[view] && d.status === 'draft')
                                .length}
                        </strong>
                      </div>
                      <div className="summary-illustration">
                        <ReceiptText size={42} strokeWidth={1.2} />
                        <span>
                          Every detail.
                          <br />
                          Accounted for.
                        </span>
                      </div>
                    </div>
                    <section className="panel documents-panel">
                      <div className="list-toolbar">
                        <div className="filter-tabs" aria-label="Filter by status">
                          {(view === 'invoices'
                            ? ['all', 'draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled']
                            : view === 'shipping'
                              ? ['all', 'draft', 'dispatched', 'delivered', 'cancelled']
                              : ['all', 'draft', 'sent', 'accepted', 'declined', 'cancelled']
                          ).map((status) => (
                            <button
                              key={status}
                              className={statusFilter === status ? 'selected' : ''}
                              onClick={() => setStatusFilter(status)}
                            >
                              {status === 'all' ? 'All documents' : statusLabel(status)}
                              <span>
                                {
                                  documents.filter(
                                    (d) =>
                                      d.kind === documentViews[view] &&
                                      (status === 'all' || statusOf(d) === status || d.status === status),
                                  ).length
                                }
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="document-list-search">
                          {businessProducts.length > 0 && (
                            <select
                              aria-label="Filter by business product"
                              value={productFilter}
                              onChange={(e) => setProductFilter(e.target.value)}
                            >
                              <option value="all">All products</option>
                              {businessProducts.map((p) => (
                                <option value={p.id} key={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <div className="search-field">
                            <Search size={17} />
                            <input
                              aria-label="Search documents"
                              placeholder="Search documents…"
                              value={search}
                              onChange={(e) => setSearch(e.target.value)}
                            />
                            {search && (
                              <button
                                className="icon-button"
                                aria-label="Clear search"
                                onClick={() => setSearch('')}
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      {renderDocumentTable()}
                      <div className="panel-footnote">
                        {filteredDocuments.length} {filteredDocuments.length === 1 ? 'document' : 'documents'}
                        <span>
                          {view === 'shipping' ? 'Quantity-only delivery documents' : 'Amounts in INR'}
                        </span>
                      </div>
                    </section>
                  </>
                )}
                {view === 'business_products' && (
                  <BusinessProductsManager
                    page={managerPage}
                    onNavigate={openManagerPage}
                    key={organizationId}
                    organization={organization}
                    products={businessProducts}
                    onSave={saveBusinessProduct}
                  />
                )}
                {view === 'catalog' && (
                  <CatalogManager
                    page={managerPage}
                    onNavigate={openManagerPage}
                    key={organizationId}
                    organization={organization}
                    items={catalog}
                    businessProducts={businessProducts}
                    onSave={saveCatalog}
                    onCreateDocument={() => newDocument('invoice')}
                  />
                )}
                {view === 'formats' && (
                  <FormatManager
                    page={managerPage}
                    onNavigate={openManagerPage}
                    key={organizationId}
                    organization={organization}
                    formats={formats}
                    onSave={saveFormat}
                    onDelete={deleteFormat}
                  />
                )}
                {view === 'customers' && (
                  <ContactsManager
                    page={managerPage}
                    onNavigate={openManagerPage}
                    key={organizationId}
                    organizationId={organizationId}
                    organizationName={organization.name}
                    contacts={customers}
                    onSave={saveContact}
                  />
                )}
                {view === 'team' && isAdmin && (
                  <TeamManager organizations={organizations} currentUser={user} />
                )}
                {view === 'integrations' && isAdmin && (
                  <IntegrationSettings key={organizationId} organization={organization} />
                )}
                {view === 'organizations' && (
                  <>
                    <div className="company-banner">
                      <div className="company-icon">
                        {workspaceSettings.dashboardLogoUrl ? (
                          <img src={workspaceSettings.dashboardLogoUrl} alt="Venturecore workspace logo" />
                        ) : (
                          <Building2 size={27} />
                        )}
                      </div>
                      <div>
                        <span>YOUR WORKSPACE</span>
                        <h2>{COMPANY_NAME}</h2>
                        <p>
                          {divisionCount} Venturecore {divisionCount === 1 ? 'division' : 'divisions'} ·{' '}
                          {independentCount} independent {independentCount === 1 ? 'business' : 'businesses'}.
                          Each organization uses its saved legal and GST details.
                        </p>
                      </div>
                      <span className="company-badge">{organizations.length} organizations</span>
                    </div>
                    <div className="organization-cards">
                      {organizations.map((org) => (
                        <article className="organization-card" key={org.id}>
                          <div className="organization-card-top">
                            <span className="org-avatar large" style={{ background: org.accentColor }}>
                              {org.logoUrl ? <img src={org.logoUrl} alt="" /> : initials(org.name)}
                            </span>
                            {org.id === organizationId && (
                              <span className="current-label">
                                <i />
                                Current
                              </span>
                            )}
                            {isAdmin && (
                              <button
                                className="icon-button"
                                aria-label={`Edit ${org.name}`}
                                onClick={() => setEditor({ type: 'organization', organization: org })}
                              >
                                <Settings2 size={18} />
                              </button>
                            )}
                          </div>
                          <h2>{org.name}</h2>
                          <p>{org.legalName || 'Add the legal business name in settings'}</p>
                          <div className="organization-meta">
                            <span>
                              Business type
                              <strong>
                                {isIndependentBusiness(org) ? 'Independent business' : 'Venturecore division'}
                              </strong>
                            </span>
                            <span>
                              Support<strong>{organizationSupportEmail(org) || 'Add in settings'}</strong>
                            </span>
                            <span>
                              Invoice prefix<strong>{org.invoicePrefix}</strong>
                            </span>
                            <span>
                              GST registration<strong>{org.gstin || 'Add in settings'}</strong>
                            </span>
                          </div>
                          <div className="organization-card-footer">
                            {isAdmin && (
                              <button
                                className="text-button muted"
                                onClick={() => setEditor({ type: 'organization', organization: org })}
                              >
                                Business settings <Pencil size={13} />
                              </button>
                            )}
                            <button
                              className="text-button green"
                              onClick={() => {
                                chooseOrganization(org.id);
                              }}
                            >
                              Open <ArrowRight size={15} />
                            </button>
                          </div>
                        </article>
                      ))}
                      {isAdmin && (
                        <button
                          className="new-organization-card"
                          onClick={() => setEditor({ type: 'organization' })}
                        >
                          <span>
                            <Plus size={25} />
                          </span>
                          <h3>Room for your next idea</h3>
                          <p>Add a division or independent business</p>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
            <footer className="workspace-footer">
              <span className="footer-brand organization-footer-mark" aria-hidden="true">
                {organization.logoUrl ? (
                  <img src={organization.logoUrl} alt="" />
                ) : (
                  initials(organization.name)
                )}
              </span>
              <span>{organization.name} workspace</span>
              <span className="footer-right">
                {organizationSupportEmail(organization) ? (
                  <a href={`mailto:${organizationSupportEmail(organization)}`}>
                    {organizationSupportEmail(organization)}
                  </a>
                ) : (
                  'Built for good business.'
                )}
              </span>
            </footer>
          </main>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  icon,
  hint,
  variant,
  onClick,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  hint: string;
  variant: string;
  onClick: () => void;
}) {
  return (
    <button className="metric-card" onClick={onClick}>
      <div className="metric-top">
        <span>{label}</span>
        <span className={`metric-icon ${variant}`}>{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-bottom">
        <span>{hint}</span>
        <ArrowUpRight size={15} />
      </div>
    </button>
  );
}
