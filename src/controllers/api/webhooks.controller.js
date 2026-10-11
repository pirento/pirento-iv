export function createController(context) {
  const { online } = context;
  return {
    postWebhooksRazorpay: (req, res, next) => online.webhookHandler(req, res, next),
    postWebhooksRazorpayOrganizationId: (req, res, next) => online.razorpayWebhookHandler(req, res, next),
    postWebhooksCashfreeOrganizationId: (req, res, next) => online.cashfreeWebhookHandler(req, res, next),
  };
}
