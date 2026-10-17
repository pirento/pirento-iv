/**
 * Payment provider webhooks (Razorpay / Cashfree). These URLs are called by the provider, not
 * the browser: there is no session, the raw body's signature is verified instead.
 */

export function createController(context) {
  const { online } = context;
  return {
    // POST /api/webhooks/razorpay
    razorpay: (req, res, next) => online.webhookHandler(req, res, next),
    // POST /api/webhooks/razorpay/:organizationId
    razorpayForOrganization: (req, res, next) => online.razorpayWebhookHandler(req, res, next),
    // POST /api/webhooks/cashfree/:organizationId
    cashfreeForOrganization: (req, res, next) => online.cashfreeWebhookHandler(req, res, next),
  };
}
