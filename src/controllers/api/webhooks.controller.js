export function createController(context) {
  const { online } = context;
  return {
    razorpay: (req, res, next) => online.webhookHandler(req, res, next),
    razorpayForOrganization: (req, res, next) => online.razorpayWebhookHandler(req, res, next),
    cashfreeForOrganization: (req, res, next) => online.cashfreeWebhookHandler(req, res, next),
  };
}
