/**
 * Payments & email page (views/integrations/index.ejs): shows which payment, email and GST settings
 * are configured for the business, the setting names to fill and the webhook URLs. Never shows secrets.
 */

import { getPageData } from '../core/page.js';
import { api, sendJson, showError } from './common.js';

const data = getPageData();
const root = document.getElementById('integrations-page');
const organization = data.organization;
const refresh = root.querySelector('[data-refresh]');
let sequence = 0;

const text = (selector, value) => {
  root.querySelector(selector).textContent = value;
};
const hidden = (selector, value) => {
  root.querySelector(selector).hidden = value;
};
function envList(selector, names) {
  root.querySelector(selector).replaceChildren(
    ...names.map((name) => {
      const code = document.createElement('code');
      code.textContent = name;
      return code;
    }),
  );
}

function render(settings) {
  const payment = settings.payment || {};
  const email = settings.email || {};
  const gst = settings.gst;
  const cashfree = payment.provider === 'cashfree';
  const manual = payment.provider === 'none';
  const provider = cashfree ? 'Cashfree' : manual ? 'Manual payments' : 'Razorpay';
  const prefix = settings.environmentPrefix || root.dataset.prefix;
  const webhook =
    settings.webhookPath ||
    `/api/webhooks/${cashfree ? 'cashfree' : 'razorpay'}/${encodeURIComponent(organization.id)}`;
  hidden('[data-status-loaded]', false);
  text('[data-provider-name]', provider);
  text('[data-provider-subtitle]', manual ? 'Bank, QR and recorded receipts' : 'Hosted payment links');
  text('[data-payment-state]', manual ? 'Manual only' : payment.configured ? 'Configured' : 'Setup needed');
  text(
    '[data-payment-description]',
    manual
      ? 'Online links are disabled. Record confirmed payments in the invoice’s Payments panel; saved bank details and payment QR remain available on your documents.'
      : `Create a ${provider} link from an invoice’s Payments panel. Verified receipts update that invoice’s balance and EMI schedule.`,
  );
  hidden('[data-online-payment]', manual);
  text(
    '[data-payment-mode]',
    payment.mode === 'live' ? 'Live payments' : payment.mode === 'test' ? 'Test mode' : 'Not configured',
  );
  text('[data-payment-key]', payment.keyConfigured ? 'Added' : 'Required');
  text('[data-payment-webhook]', payment.webhookConfigured ? 'Credentials added' : 'Required');
  text(
    '[data-payment-guidance]',
    payment.mode === 'test'
      ? 'Test mode does not collect real money. Complete a test payment before switching to live credentials.'
      : 'Full verified payment marks the invoice Paid / Final. A failed payment attempt does not reduce the balance due.',
  );
  envList(
    '[data-payment-env]',
    (cashfree
      ? ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_ENVIRONMENT']
      : ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']
    ).map((key) => `${prefix}_${key}`),
  );
  hidden('[data-cashfree-instructions]', !cashfree);
  hidden('[data-razorpay-instructions]', cashfree);
  text('[data-webhook-path]', webhook);
  const dashboard = root.querySelector('[data-payment-dashboard]');
  dashboard.href = cashfree ? 'https://merchant.cashfree.com/' : 'https://dashboard.razorpay.com/';
  dashboard.textContent = `Open ${provider} dashboard ↗`;
  text('[data-email-state]', email.configured ? 'Configured' : 'Setup needed');
  text('[data-email-from]', email.from || 'Not configured');
  text('[data-email-automation]', email.automationEnabled ? 'Enabled' : 'Off');
  text(
    '[data-email-guidance]',
    email.configured
      ? email.automationEnabled
        ? 'Automatic emails cover issued invoices and recorded payment outcomes. Check document email history to see whether the provider accepted each message.'
        : 'Manual document emails are available. Enable automation in the server settings to send invoice and payment updates automatically.'
      : email.reason || 'Add a verified sender address and an email provider API key to begin sending.',
  );
  envList('[data-email-env]', [
    `${prefix}_RESEND_API_KEY`,
    `${prefix}_EMAIL_FROM`,
    `${prefix}_EMAIL_AUTOMATION=true`,
    'PUBLIC_APP_URL',
  ]);
  hidden('[data-gst-card]', !gst);
  if (gst) {
    text(
      '[data-gst-state]',
      gst.provider === 'portal' ? 'CAPTCHA required' : gst.configured ? 'Settings added' : 'Setup needed',
    );
    text(
      '[data-gst-provider]',
      gst.provider === 'sandbox'
        ? 'Sandbox'
        : gst.provider === 'generic'
          ? 'Custom GST API'
          : 'Official GST portal',
    );
    text(
      '[data-gst-mode]',
      gst.mode === 'test'
        ? 'Test mode'
        : gst.mode === 'production'
          ? 'Production mode'
          : gst.mode === 'captcha'
            ? 'Human CAPTCHA'
            : 'Custom API',
    );
    text(
      '[data-gst-key]',
      gst.provider === 'portal'
        ? 'Not required'
        : gst.keyConfigured
          ? 'Added'
          : gst.provider === 'sandbox'
            ? 'Required'
            : 'Not set',
    );
    hidden('[data-gst-secret-row]', gst.provider !== 'sandbox');
    text('[data-gst-secret]', gst.secretConfigured ? 'Added' : 'Required');
    const guidance =
      gst.provider === 'sandbox' && gst.mode === 'test'
        ? 'Sandbox test mode returns example taxpayer records; it does not verify actual customers. Use production credentials and environment for real GST lookups.'
        : gst.provider === 'portal'
          ? 'Complete the GST portal’s CAPTCHA for each lookup, or enter contact details manually.'
          : 'Review the fetched name, address and GST status before saving. Credentials being present does not confirm a successful API connection.';
    text(
      '[data-gst-guidance]',
      guidance +
        (gst.provider === 'sandbox' && !gst.configured
          ? ' Add both Sandbox credentials to the hosting server settings to enable lookup.'
          : ''),
    );
    hidden('[data-gst-sandbox]', gst.provider !== 'sandbox');
    hidden('[data-gst-portal]', gst.provider !== 'portal');
    hidden('[data-gst-generic]', gst.provider !== 'generic');
  }
  text(
    '[data-workflow-share]',
    manual
      ? 'Include your saved bank or QR details in the invoice email.'
      : `Create a ${provider} link in Payments and include it in the invoice email.`,
  );
}

async function load() {
  const request = ++sequence;
  refresh.disabled = true;
  showError('', root);
  hidden('[data-loading]', false);
  try {
    const settings = await api(`/integrations/status?organizationId=${encodeURIComponent(organization.id)}`);
    if (request === sequence) render(settings);
  } catch (error) {
    if (request === sequence) showError(error.message, root);
  } finally {
    if (request === sequence) {
      refresh.disabled = false;
      hidden('[data-loading]', true);
    }
  }
}
refresh.addEventListener('click', load);
if (data.integrationStatus) render(data.integrationStatus);
else void load();

// AI assistant settings (the OpenAI key is write-only; the page shows its last 4 characters).
const aiForm = document.querySelector('[data-ai-form]');
if (aiForm) {
  const message = document.querySelector('[data-ai-message]');
  const remove = document.querySelector('[data-ai-remove]');
  const saveAi = async (body) => {
    message.hidden = true;
    try {
      const status = await api('/ai-settings', sendJson('PUT', body));
      document.querySelector('[data-ai-state]').textContent = status.configured
        ? `Key ending ${status.keyEnd}`
        : 'Not set';
      remove.hidden = !status.configured;
      aiForm.apiKey.value = '';
      aiForm.apiKey.placeholder = status.configured ? 'Leave blank to keep the saved key' : 'sk-...';
      message.className = 'mg-message';
      message.textContent = 'AI settings saved.';
    } catch (error) {
      message.className = 'mg-message error';
      message.textContent = error.message;
    }
    message.hidden = false;
  };
  aiForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveAi({ apiKey: aiForm.apiKey.value.trim() || undefined, model: aiForm.model.value.trim() });
  });
  remove.addEventListener('click', () => saveAi({ model: aiForm.model.value.trim(), removeKey: true }));
}

// Payments & email settings of this business (secrets are write-only).
const settingsForm = document.querySelector('[data-settings-form]');
if (settingsForm) {
  const message = document.querySelector('[data-settings-message]');
  const organizationId = getPageData().organization.id;
  const saveSettings = async (body) => {
    message.hidden = true;
    try {
      await api(`/integrations/${encodeURIComponent(organizationId)}/settings`, sendJson('PUT', body));
      // Reload so the status cards and saved-key hints show the new settings.
      window.location.reload();
    } catch (error) {
      message.className = 'mg-message error';
      message.textContent = error.message;
      message.hidden = false;
    }
  };
  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(settingsForm));
    // A blank secret keeps the saved one.
    for (const field of settingsForm.querySelectorAll('input[type="password"]'))
      if (!values[field.name]) delete values[field.name];
    saveSettings(values);
  });
  for (const button of settingsForm.querySelectorAll('[data-clear]'))
    button.addEventListener('click', () => saveSettings({ clear: [button.dataset.clear] }));
}

// Sends one test email with this business's saved settings and shows the result.
const testForm = document.querySelector('[data-test-email]');
if (testForm) {
  const message = document.querySelector('[data-test-message]');
  testForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = testForm.querySelector('button');
    button.disabled = true;
    message.hidden = true;
    try {
      const result = await api(
        `/integrations/${encodeURIComponent(getPageData().organization.id)}/test-email`,
        sendJson('POST', { to: testForm.to.value.trim() }),
      );
      message.className = 'mg-message success';
      message.textContent = `Test email sent from ${result.from} (${result.provider === 'smtp' ? 'SMTP' : 'Resend'}). Replies go to ${result.replyTo}.`;
    } catch (error) {
      message.className = 'mg-message error';
      message.textContent = error.message;
    }
    message.hidden = false;
    button.disabled = false;
  });
}
