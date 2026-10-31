/**
 * Online payment front door: picks Razorpay or Cashfree for each business (its gateway setting)
 * and forwards payment-link and webhook calls to the matching module.
 * Used by the API as `online` (createPaymentLink, syncDocument, cancelPaymentLink, webhooks).
 */

import { flatMapAsync } from '../../async-collections.js';
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { COMPANY_NAME } from '../../../../shared/types.js';
import {
  integrationEnvironmentPrefix,
  isIndependentBusiness,
  organizationGateway,
} from '../../../../shared/business-identity.js';
import { organizationEnvironment } from '../../../config/business-config.js';
import { createCashfreePayments, verifyCashfreeSignature } from './cashfree-payments.js';
import {
  createOnlinePayments,
  OnlinePaymentError,
  paymentErrorResponse,
  verifyRazorpaySignature,
} from './online-payments.js';
import { discardProviderResponse, readProviderJson } from '../provider-http.js';
const terminal = (state) => ['paid', 'cancelled', 'expired'].includes(state);
const disabled = () => ({
  provider: 'none',
  configured: false,
  keyConfigured: false,
  webhookConfigured: false,
  mode: 'unconfigured',
});
/** Creates the gateway router; provider modules are created per business on first use. */
export function createPaymentGateways(options) {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const modules = new Map();
  const metadata = createOnlinePayments({
    ...options,
    getDocument: () => undefined,
  });
  createCashfreePayments({
    ...options,
    organizationId: '__metadata_only__',
    getDocument: () => undefined,
  });
  async function documentFor(id) {
    let document;
    try {
      document = await options.getDocument(id);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!document) throw new OnlinePaymentError('Invoice not found.', 404);
    return document;
  }
  // Settings saved on the Payments & email page (integration-settings.js) for this business.
  const savedFor = async (id) => (options.integrationSettings ? options.integrationSettings(id) : {});
  async function organizationFor(id) {
    let organization;
    try {
      organization = await options.getOrganization(id);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!organization) throw new OnlinePaymentError('Business not found.', 404);
    return organization;
  }
  async function selected(document) {
    const current = await organizationFor(document.organizationId);
    return document.organizationSnapshot?.paymentGateway ?? organizationGateway(current);
  }
  async function assertInvoiceMerchant(document) {
    const current = await organizationFor(document.organizationId);
    const snapshot = document.organizationSnapshot;
    if (!snapshot) return;
    const normalized = (value) => (value ?? '').trim().toUpperCase();
    const pan = (organization) => {
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
  async function provider(organizationId, gateway) {
    const organization = await organizationFor(organizationId);
    const scopedEnv = organizationEnvironment(organization, env, await savedFor(organizationId));
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
        getDocument: async (id) => {
          const document = await documentFor(id);
          return document.organizationId === organizationId ? document : undefined;
        },
      };
      module =
        gateway === 'cashfree'
          ? createCashfreePayments({
              ...scopedOptions,
              organizationId,
            })
          : createOnlinePayments(scopedOptions);
      modules.set(key, module);
    }
    return module;
  }
  async function getStatus(organizationId, documentId) {
    if (documentId) {
      const document = await documentFor(documentId);
      if (organizationId && organizationId !== document.organizationId)
        throw new OnlinePaymentError('Invoice is outside the selected business.', 404);
      const gateway = await selected(document);
      return gateway === 'none'
        ? disabled()
        : await (await provider(document.organizationId, gateway)).getStatus();
    }
    if (!organizationId) return await metadata.getStatus();
    const gateway = organizationGateway(await organizationFor(organizationId));
    return gateway === 'none' ? disabled() : await (await provider(organizationId, gateway)).getStatus();
  }
  async function getDocumentPayments(id) {
    const document = await documentFor(id);
    const links = (
      await flatMapAsync(['razorpay', 'cashfree'], async (gateway) =>
        (await (await provider(document.organizationId, gateway)).getDocumentPayments(id)).links.map(
          (link) => ({
            ...link,
            provider: gateway,
          }),
        ),
      )
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      configuration: await getStatus(document.organizationId, id),
      links,
      hasBlockingPaymentLink: links.some((link) => !terminal(link.state)),
    };
  }
  async function assertManualChangesAllowed(id) {
    if ((await getDocumentPayments(id)).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile every active online payment link before changing this invoice or recording an offline payment.',
        409,
      );
  }
  async function assertOrganizationChangesAllowed(current, next) {
    if (current.id !== next.id)
      throw new OnlinePaymentError('A business identity cannot be reassigned.', 409);
    if (
      organizationGateway(current) === organizationGateway(next) &&
      isIndependentBusiness(current) === isIndependentBusiness(next)
    )
      return;
    const rows = await options.db.models.documents.list(current.id);
    for (const row of rows) await assertManualChangesAllowed(row.id);
  }
  async function createPaymentLink(id) {
    const document = await documentFor(id);
    const gateway = await selected(document);
    await assertInvoiceMerchant(document);
    if (gateway === 'none')
      throw new OnlinePaymentError(
        'Online payments are disabled for this invoice. Use its bank or QR details to record an offline payment.',
        409,
      );
    const details = await getDocumentPayments(id);
    if (details.links.some((link) => link.provider !== gateway && !terminal(link.state)))
      throw new OnlinePaymentError(
        'Cancel or reconcile the previous provider’s payment link before creating another payable link.',
        409,
      );
    await (await provider(document.organizationId, gateway)).createPaymentLink(id);
    return await getDocumentPayments(id);
  }
  async function syncDocument(id) {
    const document = await documentFor(id);
    const details = await getDocumentPayments(id);
    for (const gateway of ['razorpay', 'cashfree'])
      if (details.links.some((link) => link.provider === gateway && !terminal(link.state)))
        await (await provider(document.organizationId, gateway)).syncDocument(id);
    return await getDocumentPayments(id);
  }
  async function cancelPaymentLink(id) {
    const document = await documentFor(id);
    const details = await getDocumentPayments(id);
    for (const gateway of ['razorpay', 'cashfree'])
      if (details.links.some((link) => link.provider === gateway && !terminal(link.state)))
        await (await provider(document.organizationId, gateway)).cancelPaymentLink(id);
    return await getDocumentPayments(id);
  }
  function parseRazorpay(body) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return parsed;
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
  }
  async function localRazorpayDocument(event) {
    const linkId = event.payload?.payment_link?.entity?.id ?? event.payload?.payment?.entity?.payment_link_id;
    const reference =
      event.payload?.payment_link?.entity?.reference_id ??
      event.payload?.payment?.entity?.notes?.reference_id;
    const paymentId = event.payload?.payment?.entity?.id;
    let row =
      typeof linkId === 'string' ? await options.db.models.razorpay.linkByProvider(linkId) : undefined;
    if (!row && typeof reference === 'string')
      row = await options.db.models.razorpay.linkByReference(reference);
    if (!row && typeof paymentId === 'string')
      row = await options.db.models.razorpay.linkByPayment(paymentId);
    return (
      row?.document_id ??
      (typeof event.payload?.payment?.entity?.notes?.document_id === 'string'
        ? event.payload.payment.entity.notes.document_id
        : undefined)
    );
  }
  function permitsLegacy(organization) {
    const prefix = integrationEnvironmentPrefix(organization);
    return (
      !isIndependentBusiness(organization) &&
      !['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].some(
        (key) => env[`${prefix}_${key}`] !== undefined,
      )
    );
  }
  async function discoverLegacyDocument(event) {
    const local = await localRazorpayDocument(event);
    if (local) return local;
    const paymentId = event.payload?.payment?.entity?.id;
    if (typeof paymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return undefined;
    if (!(await metadata.getStatus()).configured)
      throw new OnlinePaymentError('Global Razorpay credentials are not configured.', 503);
    let response;
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
    let result;
    try {
      result = await readProviderJson(response);
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
    return (await options.db.models.razorpay.linkByProviderReference(links[0].id, links[0].reference_id))
      ?.document_id;
  }
  function scopedEventKey(organizationId, body, eventId) {
    return createHash('sha256')
      .update(organizationId)
      .update('\0')
      .update(eventId ?? createHash('sha256').update(body).digest('hex'))
      .digest('hex');
  }
  async function processWebhook(body, signature, eventId) {
    if (!verifyRazorpaySignature(body, signature, env.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    const documentId = await discoverLegacyDocument(parseRazorpay(body));
    if (!documentId)
      return {
        received: true,
        ignored: true,
      };
    const document = await documentFor(documentId);
    const organization = await organizationFor(document.organizationId);
    if (!permitsLegacy(organization))
      return {
        received: true,
        ignored: true,
      };
    return await processRazorpayWebhook(organization.id, body, signature, eventId);
  }
  async function processRazorpayWebhook(organizationId, body, signature, eventId) {
    const organization = await organizationFor(organizationId);
    const scopedEnv = organizationEnvironment(organization, env, await savedFor(organizationId));
    if (!verifyRazorpaySignature(body, signature, scopedEnv.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    const candidate = await localRazorpayDocument(parseRazorpay(body));
    if (candidate && (await documentFor(candidate)).organizationId !== organizationId)
      return {
        received: true,
        ignored: true,
      };
    return (await provider(organizationId, 'razorpay')).processWebhook(
      body,
      signature,
      scopedEventKey(organizationId, body, eventId),
    );
  }
  async function processCashfreeWebhook(organizationId, body, signature, timestamp, eventId) {
    const scopedEnv = organizationEnvironment(
      await organizationFor(organizationId),
      env,
      await savedFor(organizationId),
    );
    if (!verifyCashfreeSignature(body, signature, timestamp, scopedEnv.CASHFREE_CLIENT_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    return (await provider(organizationId, 'cashfree')).processWebhook(body, signature, timestamp, eventId);
  }
  const router = Router();
  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(String(req.params.id)));
    } catch (error) {
      const { status, message } = paymentErrorResponse(error, 'Online payment operation failed.');
      res.status(status).json({ error: message });
    }
  };
  router.get('/documents/:id/online-payments', route(getDocumentPayments));
  router.post('/documents/:id/payment-link', route(createPaymentLink));
  router.post('/documents/:id/payment-link/sync', route(syncDocument));
  router.post('/documents/:id/payment-link/cancel', route(cancelPaymentLink));
  const handler = (kind) => async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body))
        throw new OnlinePaymentError('Webhook requires the original request body.');
      res.json(
        await (kind === 'legacy'
          ? await processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'))
          : kind === 'razorpay'
            ? await processRazorpayWebhook(
                String(req.params.organizationId),
                req.body,
                req.get('x-razorpay-signature'),
                req.get('x-razorpay-event-id'),
              )
            : await processCashfreeWebhook(
                String(req.params.organizationId),
                req.body,
                req.get('x-webhook-signature'),
                req.get('x-webhook-timestamp'),
                req.get('x-idempotency-header'),
              )),
      );
    } catch (error) {
      const { status, message } = paymentErrorResponse(error, 'Webhook processing failed; retry delivery.');
      res.status(status).json({ error: message });
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
