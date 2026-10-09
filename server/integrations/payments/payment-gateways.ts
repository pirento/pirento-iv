import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { COMPANY_NAME, type BusinessDocument, type Organization } from '../../../shared/types.ts';
import type {
  OnlinePaymentConfiguration,
  OnlinePaymentDetails,
  OnlinePaymentLink,
} from '../../../shared/online-payment-types.ts';
import {
  integrationEnvironmentPrefix,
  isIndependentBusiness,
  organizationGateway,
} from '../../../shared/business-identity.ts';
import { organizationEnvironment } from '../../config/business-config.ts';
import { createCashfreePayments, verifyCashfreeSignature } from './cashfree-payments.ts';
import {
  createOnlinePayments,
  OnlinePaymentError,
  verifyRazorpaySignature,
  type OnlinePaymentOptions,
} from './online-payments.ts';
import { discardProviderResponse, readProviderJson } from '../provider-http.ts';

export interface PaymentGatewayOptions extends OnlinePaymentOptions {
  getOrganization: (id: string) => Organization | undefined;
  listOrganizations?: () => Organization[];
}
type Gateway = 'razorpay' | 'cashfree';
type ProviderModule = ReturnType<typeof createOnlinePayments> | ReturnType<typeof createCashfreePayments>;
const terminal = (state: string) => ['paid', 'cancelled', 'expired'].includes(state);
const disabled = (): OnlinePaymentConfiguration => ({
  provider: 'none',
  configured: false,
  keyConfigured: false,
  webhookConfigured: false,
  mode: 'unconfigured',
});

/** Routing owns business identity; provider modules only ever see their own invoices. */
export function createPaymentGateways(options: PaymentGatewayOptions) {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const modules = new Map<string, ProviderModule>();
  // Initialize shared tables, without giving this metadata-only instance access
  // to any invoice. Every operational instance below is scoped to one business.
  const metadata = createOnlinePayments({ ...options, getDocument: () => undefined });
  // DDL must run before any application payment/organization transaction. If a
  // first lazy read created tables inside a later rollback, cached modules would
  // otherwise point at tables that no longer existed.
  createCashfreePayments({ ...options, organizationId: '__metadata_only__', getDocument: () => undefined });
  function documentFor(id: string): BusinessDocument {
    let document: BusinessDocument | undefined;
    try {
      document = options.getDocument(id);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    if (!document) throw new OnlinePaymentError('Invoice not found.', 404);
    return document;
  }
  function organizationFor(id: string): Organization {
    let organization: Organization | undefined;
    try {
      organization = options.getOrganization(id);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    if (!organization) throw new OnlinePaymentError('Business not found.', 404);
    return organization;
  }
  function selected(document: BusinessDocument) {
    const current = organizationFor(document.organizationId);
    return document.organizationSnapshot?.paymentGateway ?? organizationGateway(current);
  }
  function assertInvoiceMerchant(document: BusinessDocument) {
    const current = organizationFor(document.organizationId);
    const snapshot = document.organizationSnapshot;
    if (!snapshot) return;
    const normalized = (value?: string) => (value ?? '').trim().toUpperCase();
    const pan = (organization: Organization) => {
      const explicit = normalized(organization.pan);
      if (/^[A-Z]{5}\d{4}[A-Z]$/.test(explicit)) return explicit;
      const gstin = normalized(organization.gstin);
      return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin) ? gstin.slice(2, 12) : '';
    };
    const oldPan = pan(snapshot);
    const currentPan = pan(current);
    const inheritedCompany =
      isIndependentBusiness(current) &&
      normalized(snapshot.legalName) === normalized(COMPANY_NAME) &&
      normalized(current.legalName) !== normalized(COMPANY_NAME);
    if (inheritedCompany || (oldPan && currentPan && oldPan !== currentPan)) {
      throw new OnlinePaymentError(
        'This invoice was issued by a different legal business. Its saved issuer must not collect through the current business’s gateway. Reconcile the original merchant account separately.',
        409,
      );
    }
  }
  function provider(organizationId: string, gateway: Gateway): ProviderModule {
    const organization = organizationFor(organizationId);
    const scopedEnv = organizationEnvironment(organization, env);
    const relevant =
      gateway === 'razorpay'
        ? [scopedEnv.RAZORPAY_KEY_ID, scopedEnv.RAZORPAY_KEY_SECRET, scopedEnv.RAZORPAY_WEBHOOK_SECRET]
        : [scopedEnv.CASHFREE_CLIENT_ID, scopedEnv.CASHFREE_CLIENT_SECRET, scopedEnv.CASHFREE_ENVIRONMENT];
    const key = `${organizationId}:${gateway}:${createHash('sha256').update(JSON.stringify(relevant)).digest('hex')}`;
    let module = modules.get(key);
    if (!module) {
      const scopedOptions = {
        ...options,
        env: scopedEnv,
        getDocument: (id: string) => {
          const document = documentFor(id);
          return document.organizationId === organizationId ? document : undefined;
        },
      };
      module =
        gateway === 'cashfree'
          ? createCashfreePayments({ ...scopedOptions, organizationId })
          : createOnlinePayments(scopedOptions);
      modules.set(key, module);
    }
    return module;
  }
  function getStatus(organizationId?: string, documentId?: string): OnlinePaymentConfiguration {
    if (documentId) {
      const document = documentFor(documentId);
      if (organizationId && organizationId !== document.organizationId)
        throw new OnlinePaymentError('Invoice is outside the selected business.', 404);
      const gateway = selected(document);
      return gateway === 'none' ? disabled() : provider(document.organizationId, gateway).getStatus();
    }
    if (!organizationId) return metadata.getStatus();
    const gateway = organizationGateway(organizationFor(organizationId));
    return gateway === 'none' ? disabled() : provider(organizationId, gateway).getStatus();
  }
  function getDocumentPayments(id: string): OnlinePaymentDetails {
    const document = documentFor(id);
    const links: OnlinePaymentLink[] = (['razorpay', 'cashfree'] as const)
      .flatMap((gateway) =>
        provider(document.organizationId, gateway)
          .getDocumentPayments(id)
          .links.map((link) => ({ ...link, provider: gateway })),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      configuration: getStatus(document.organizationId, id),
      links,
      hasBlockingPaymentLink: links.some((link) => !terminal(link.state)),
    };
  }
  function assertManualChangesAllowed(id: string) {
    if (getDocumentPayments(id).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile every active online payment link before changing this invoice or recording an offline payment.',
        409,
      );
  }
  function assertOrganizationChangesAllowed(current: Organization, next: Organization) {
    if (current.id !== next.id)
      throw new OnlinePaymentError('A business identity cannot be reassigned.', 409);
    if (
      organizationGateway(current) === organizationGateway(next) &&
      isIndependentBusiness(current) === isIndependentBusiness(next)
    )
      return;
    const rows = options.db
      .prepare("SELECT id FROM documents WHERE json_extract(data, '$.organizationId') = ?")
      .all(current.id) as { id: string }[];
    for (const row of rows) assertManualChangesAllowed(row.id);
  }
  async function createPaymentLink(id: string): Promise<OnlinePaymentDetails> {
    const document = documentFor(id);
    const gateway = selected(document);
    assertInvoiceMerchant(document);
    if (gateway === 'none')
      throw new OnlinePaymentError(
        'Online payments are disabled for this invoice. Use its bank or QR details to record an offline payment.',
        409,
      );
    const details = getDocumentPayments(id);
    if (details.links.some((link) => link.provider !== gateway && !terminal(link.state)))
      throw new OnlinePaymentError(
        'Cancel or reconcile the previous provider’s payment link before creating another payable link.',
        409,
      );
    await provider(document.organizationId, gateway).createPaymentLink(id);
    return getDocumentPayments(id);
  }
  async function syncDocument(id: string): Promise<OnlinePaymentDetails> {
    const document = documentFor(id);
    const details = getDocumentPayments(id);
    for (const gateway of ['razorpay', 'cashfree'] as const)
      if (details.links.some((link) => link.provider === gateway && !terminal(link.state)))
        await provider(document.organizationId, gateway).syncDocument(id);
    return getDocumentPayments(id);
  }
  async function cancelPaymentLink(id: string): Promise<OnlinePaymentDetails> {
    const document = documentFor(id);
    const details = getDocumentPayments(id);
    for (const gateway of ['razorpay', 'cashfree'] as const)
      if (details.links.some((link) => link.provider === gateway && !terminal(link.state)))
        await provider(document.organizationId, gateway).cancelPaymentLink(id);
    return getDocumentPayments(id);
  }

  type RazorpayEvent = {
    payload?: {
      payment_link?: { entity?: { id?: string; reference_id?: string } };
      payment?: {
        entity?: {
          id?: string;
          payment_link_id?: string;
          notes?: { reference_id?: string; document_id?: string };
        };
      };
    };
  };
  function parseRazorpay(body: Buffer): RazorpayEvent {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return parsed as RazorpayEvent;
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
  }
  function localRazorpayDocument(event: RazorpayEvent): string | undefined {
    const linkId = event.payload?.payment_link?.entity?.id ?? event.payload?.payment?.entity?.payment_link_id;
    const reference =
      event.payload?.payment_link?.entity?.reference_id ??
      event.payload?.payment?.entity?.notes?.reference_id;
    const paymentId = event.payload?.payment?.entity?.id;
    let row =
      typeof linkId === 'string'
        ? (options.db
            .prepare('SELECT document_id FROM online_payment_links WHERE provider_id = ?')
            .get(linkId) as { document_id: string } | undefined)
        : undefined;
    if (!row && typeof reference === 'string')
      row = options.db
        .prepare('SELECT document_id FROM online_payment_links WHERE reference_id = ?')
        .get(reference) as { document_id: string } | undefined;
    if (!row && typeof paymentId === 'string')
      row = options.db
        .prepare(
          'SELECT l.document_id FROM online_payment_links l JOIN online_verified_payments p ON p.link_id = l.id WHERE p.provider_payment_id = ?',
        )
        .get(paymentId) as { document_id: string } | undefined;
    // Notes only select the business; the provider adapter independently verifies
    // link membership, currency, capture status and invoice balance before credit.
    return (
      row?.document_id ??
      (typeof event.payload?.payment?.entity?.notes?.document_id === 'string'
        ? event.payload.payment.entity.notes.document_id
        : undefined)
    );
  }
  function permitsLegacy(organization: Organization) {
    const prefix = integrationEnvironmentPrefix(organization);
    return (
      !isIndependentBusiness(organization) &&
      !['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].some(
        (key) => env[`${prefix}_${key}`] !== undefined,
      )
    );
  }
  async function discoverLegacyDocument(event: RazorpayEvent) {
    const local = localRazorpayDocument(event);
    if (local) return local;
    const paymentId = event.payload?.payment?.entity?.id;
    if (typeof paymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return undefined;
    if (!metadata.getStatus().configured)
      throw new OnlinePaymentError('Global Razorpay credentials are not configured.', 503);
    let response: Response;
    try {
      response = await request(
        `https://api.razorpay.com/v1/payment_links?payment_id=${encodeURIComponent(paymentId)}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch {
      throw new OnlinePaymentError(
        'Razorpay could not be reached while routing the webhook. Retry delivery.',
        502,
      );
    }
    if (!response.ok) {
      discardProviderResponse(response);
      throw new OnlinePaymentError('Razorpay could not verify this payment’s link. Retry delivery.', 502);
    }
    let result: {
      payment_links?: { id?: string; reference_id?: string }[];
      items?: { id?: string; reference_id?: string }[];
    };
    try {
      result = await readProviderJson<typeof result>(response);
    } catch {
      throw new OnlinePaymentError('Razorpay returned an invalid link response.', 502);
    }
    const links = result.payment_links ?? result.items ?? [];
    if (
      !Array.isArray(links) ||
      links.length !== 1 ||
      typeof links[0].id !== 'string' ||
      typeof links[0].reference_id !== 'string'
    )
      return undefined;
    return (
      options.db
        .prepare('SELECT document_id FROM online_payment_links WHERE provider_id = ? AND reference_id = ?')
        .get(links[0].id, links[0].reference_id) as { document_id: string } | undefined
    )?.document_id;
  }
  function scopedEventKey(organizationId: string, body: Buffer, eventId?: string) {
    return createHash('sha256')
      .update(organizationId)
      .update('\0')
      .update(eventId ?? createHash('sha256').update(body).digest('hex'))
      .digest('hex');
  }
  /** Backward-compatible legacy webhook; only global, shared-company credentials. */
  async function processWebhook(body: Buffer, signature: unknown, eventId?: string) {
    if (!verifyRazorpaySignature(body, signature, env.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    const documentId = await discoverLegacyDocument(parseRazorpay(body));
    if (!documentId) return { received: true, ignored: true };
    const document = documentFor(documentId);
    const organization = organizationFor(document.organizationId);
    if (!permitsLegacy(organization)) return { received: true, ignored: true };
    return processRazorpayWebhook(organization.id, body, signature, eventId);
  }
  async function processRazorpayWebhook(
    organizationId: string,
    body: Buffer,
    signature: unknown,
    eventId?: string,
  ) {
    const organization = organizationFor(organizationId);
    const scopedEnv = organizationEnvironment(organization, env);
    if (!verifyRazorpaySignature(body, signature, scopedEnv.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    const candidate = localRazorpayDocument(parseRazorpay(body));
    if (candidate && documentFor(candidate).organizationId !== organizationId)
      return { received: true, ignored: true };
    return (provider(organizationId, 'razorpay') as ReturnType<typeof createOnlinePayments>).processWebhook(
      body,
      signature,
      scopedEventKey(organizationId, body, eventId),
    );
  }
  async function processCashfreeWebhook(
    organizationId: string,
    body: Buffer,
    signature: unknown,
    timestamp: unknown,
    eventId?: string,
  ) {
    const scopedEnv = organizationEnvironment(organizationFor(organizationId), env);
    if (!verifyCashfreeSignature(body, signature, timestamp, scopedEnv.CASHFREE_CLIENT_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    return (provider(organizationId, 'cashfree') as ReturnType<typeof createCashfreePayments>).processWebhook(
      body,
      signature,
      timestamp,
      eventId,
    );
  }
  const router = Router();
  const route =
    (fn: (id: string) => unknown | Promise<unknown>): RequestHandler =>
    async (req, res) => {
      try {
        res.json(await fn(String(req.params.id)));
      } catch (error) {
        res.status(error instanceof OnlinePaymentError ? error.status : 500).json({
          error: error instanceof OnlinePaymentError ? error.message : 'Online payment operation failed.',
        });
      }
    };
  router.get('/documents/:id/online-payments', route(getDocumentPayments));
  router.post('/documents/:id/payment-link', route(createPaymentLink));
  router.post('/documents/:id/payment-link/sync', route(syncDocument));
  router.post('/documents/:id/payment-link/cancel', route(cancelPaymentLink));
  const handler =
    (kind: 'legacy' | Gateway): RequestHandler =>
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body))
          throw new OnlinePaymentError('Webhook requires the original request body.');
        res.json(
          await (kind === 'legacy'
            ? processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'))
            : kind === 'razorpay'
              ? processRazorpayWebhook(
                  String(req.params.organizationId),
                  req.body,
                  req.get('x-razorpay-signature'),
                  req.get('x-razorpay-event-id'),
                )
              : processCashfreeWebhook(
                  String(req.params.organizationId),
                  req.body,
                  req.get('x-webhook-signature'),
                  req.get('x-webhook-timestamp'),
                  req.get('x-idempotency-header'),
                )),
        );
      } catch (error) {
        res.status(error instanceof OnlinePaymentError ? error.status : 500).json({
          error:
            error instanceof OnlinePaymentError
              ? error.message
              : 'Webhook processing failed; retry delivery.',
        });
      }
    };
  return {
    router,
    webhookHandler: handler('legacy'),
    razorpayWebhookHandler: handler('razorpay'),
    cashfreeWebhookHandler: handler('cashfree'),
    getStatus,
    getDocumentPayments,
    createPaymentLink,
    syncDocument,
    cancelPaymentLink,
    assertManualChangesAllowed,
    assertOrganizationChangesAllowed,
    processWebhook,
    processRazorpayWebhook,
    processCashfreeWebhook,
  };
}
