import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CreditCard,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../../shared/api/api';
import {
  integrationEnvironmentPrefix,
  isIndependentBusiness,
  organizationSupportEmail,
} from '../../../shared/business-identity';
import type { Organization } from '../../../shared/types';
import type { EmailIntegrationStatus } from '../../../shared/messaging-types';
import type { OnlinePaymentConfiguration } from '../../../shared/online-payment-types';
import './integrations.css';

interface IntegrationStatus {
  email: EmailIntegrationStatus;
  payment: OnlinePaymentConfiguration;
  environmentPrefix?: string;
  webhookPath?: string;
}
function SetupState({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  return (
    <span className={`integration-state ${ready ? 'ready' : ''}`}>
      {ready ? <Check size={12} /> : <Settings2 size={12} />} {children}
    </span>
  );
}

export default function IntegrationSettings({ organization }: { organization: Organization }) {
  const [settings, setSettings] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setSettings(null);
    try {
      const result = await api<IntegrationStatus>(
        `/integrations/status?organizationId=${encodeURIComponent(organization.id)}`,
      );
      if (request === sequence.current) setSettings(result);
    } catch (err) {
      if (request === sequence.current)
        setError(err instanceof Error ? err.message : 'Could not load integration settings.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [organization.id]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const payment = settings?.payment;
  const cashfree = payment?.provider === 'cashfree';
  const manualOnly = payment?.provider === 'none';
  const providerName = cashfree ? 'Cashfree' : manualOnly ? 'Manual payments' : 'Razorpay';
  const prefix = settings?.environmentPrefix || integrationEnvironmentPrefix(organization);
  const independent = isIndependentBusiness(organization);
  const env = (name: string) => `${prefix}_${name}`;
  const webhookPath =
    settings?.webhookPath ||
    `/api/webhooks/${cashfree ? 'cashfree' : 'razorpay'}/${encodeURIComponent(organization.id)}`;
  return (
    <div className="integration-settings">
      <div className="integration-intro">
        <div>
          <span className="page-eyebrow">{organization.name.toUpperCase()} · CONNECTED WORKFLOWS</span>
          <h2>Payments and email for {organization.name}</h2>
          <p>
            Review this business’s payment provider and sender. Change the gateway, support address, bank
            details and QR in organization settings.
          </p>
          <div className="integration-business">
            <span>
              <strong>Legal business</strong>
              {organization.legalName}
            </span>
            <span>
              <strong>Support</strong>
              {organizationSupportEmail(organization) || 'Not set'}
            </span>
            <span>
              <strong>Business type</strong>
              {independent ? 'Independent business' : 'Venturecore division'}
            </span>
          </div>
        </div>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          Refresh status
        </button>
      </div>
      {error && (
        <div className="inv-form-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="team-empty" role="status">
          <LoaderCircle size={24} className="spin" />
          <p>Checking {organization.name} integration configuration…</p>
        </div>
      ) : (
        settings &&
        payment && (
          <>
            <div className="integration-cards">
              <section className="integration-card">
                <div className="integration-card-heading">
                  <span className="integration-icon payments">
                    <CreditCard size={24} />
                  </span>
                  <div>
                    <h3>{providerName}</h3>
                    <p>{manualOnly ? 'Bank, QR and recorded receipts' : 'Hosted payment links'}</p>
                  </div>
                  <SetupState ready={manualOnly || payment.configured}>
                    {manualOnly ? 'Manual only' : payment.configured ? 'Configured' : 'Setup needed'}
                  </SetupState>
                </div>
                <p className="integration-description">
                  {manualOnly
                    ? 'Online links are disabled. Record confirmed payments in the invoice’s Payments panel; saved bank details and payment QR remain available on your documents.'
                    : `Create a ${providerName} link from an invoice’s Payments panel. Verified receipts update that invoice’s balance and EMI schedule.`}
                </p>
                {!manualOnly && (
                  <>
                    <dl>
                      <div>
                        <dt>Mode</dt>
                        <dd>
                          {payment.mode === 'live'
                            ? 'Live payments'
                            : payment.mode === 'test'
                              ? 'Test mode'
                              : 'Not configured'}
                        </dd>
                      </div>
                      <div>
                        <dt>API credentials</dt>
                        <dd>{payment.keyConfigured ? 'Added' : 'Required'}</dd>
                      </div>
                      <div>
                        <dt>Webhook verification</dt>
                        <dd>{payment.webhookConfigured ? 'Credentials added' : 'Required'}</dd>
                      </div>
                    </dl>
                    <div className="integration-guidance">
                      <ShieldCheck size={17} />
                      <p>
                        {payment.mode === 'test'
                          ? 'Test mode does not collect real money. Complete a test payment before switching to live credentials.'
                          : 'Full verified payment marks the invoice Paid / Final. A failed payment attempt does not reduce the balance due.'}
                      </p>
                    </div>
                    <details>
                      <summary>Connection instructions</summary>
                      <p>
                        {independent
                          ? `${organization.name} uses its own credentials; it never inherits the Venturecore payment account.`
                          : `These organization-specific settings can override the shared Venturecore account. If no organization override is set, this division uses the shared credentials.`}{' '}
                        Add credentials in the hosting server settings, then restart the application.
                      </p>
                      <div className="integration-env">
                        {(cashfree
                          ? ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_ENVIRONMENT']
                          : ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']
                        ).map((key) => (
                          <code key={key}>{env(key)}</code>
                        ))}
                      </div>
                      {cashfree ? (
                        <>
                          <p>
                            Set Cashfree environment to <code>sandbox</code> for test payments or{' '}
                            <code>production</code> for live payments. Cashfree signs webhooks using the
                            client secret; no separate webhook secret is needed.
                          </p>
                          <p>
                            In the Cashfree dashboard, configure your HTTPS domain with{' '}
                            <code>{webhookPath}</code> for payment-link and payment success / failure
                            notifications. Add a valid Indian mobile number to the customer before creating a
                            link.
                          </p>
                        </>
                      ) : (
                        <p>
                          In the Razorpay dashboard, configure your HTTPS domain with{' '}
                          <code>{webhookPath}</code>. Subscribe to payment-link paid / partially paid /
                          cancelled / expired events and payment captured / failed events.
                        </p>
                      )}
                      <p>
                        Configured means the required settings are present. Verify the connection with a test
                        invoice, completed test payment and received webhook.
                      </p>
                      <a
                        href={cashfree ? 'https://merchant.cashfree.com/' : 'https://dashboard.razorpay.com/'}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open {providerName} dashboard <ExternalLink size={13} />
                      </a>
                    </details>
                  </>
                )}
              </section>
              <section className="integration-card">
                <div className="integration-card-heading">
                  <span className="integration-icon emails">
                    <Mail size={24} />
                  </span>
                  <div>
                    <h3>Invoice emails</h3>
                    <p>Sender for {organization.name}</p>
                  </div>
                  <SetupState ready={settings.email.configured}>
                    {settings.email.configured ? 'Configured' : 'Setup needed'}
                  </SetupState>
                </div>
                <p className="integration-description">
                  Send document emails, include payment links and track delivery attempts from the Email
                  button in a document preview.
                </p>
                <dl>
                  <div>
                    <dt>Sender</dt>
                    <dd>{settings.email.from || 'Not configured'}</dd>
                  </div>
                  <div>
                    <dt>Support / reply-to</dt>
                    <dd>{organizationSupportEmail(organization) || 'Not set'}</dd>
                  </div>
                  <div>
                    <dt>Automatic emails</dt>
                    <dd>{settings.email.automationEnabled ? 'Enabled' : 'Off'}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>Resend</dd>
                  </div>
                </dl>
                <div className="integration-guidance">
                  <Mail size={17} />
                  <p>
                    {settings.email.configured
                      ? settings.email.automationEnabled
                        ? 'Automatic emails cover issued invoices and recorded payment outcomes. Check document email history to see whether the provider accepted each message.'
                        : 'Manual document emails are available. Enable automation in the server settings to send invoice and payment updates automatically.'
                      : settings.email.reason ||
                        'Add a verified sender address and an email provider API key to begin sending.'}
                  </p>
                </div>
                <details>
                  <summary>Connection instructions</summary>
                  <p>
                    Verify your sending domain with Resend, then add this business’s API key and sender
                    address in the hosting server settings.{' '}
                    {independent
                      ? 'This independent business does not inherit the Venturecore sender or email credentials.'
                      : 'Without an organization-specific override, this division uses the shared Venturecore sender.'}
                  </p>
                  <div className="integration-env">
                    <code>{env('RESEND_API_KEY')}</code>
                    <code>{env('EMAIL_FROM')}</code>
                    <code>{env('EMAIL_AUTOMATION')}=true</code>
                    <code>PUBLIC_APP_URL</code>
                  </div>
                  <p>
                    The support address is the reply-to contact; entering it does not verify or activate an
                    email sender. Set the public application URL to your HTTPS website address, and restart
                    after changing credentials.
                  </p>
                  <p>
                    Use a test invoice to check the sender and payment link before enabling automatic emails.
                    “Provider accepted” records provider acceptance; it does not confirm inbox delivery.
                  </p>
                  <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">
                    Open Resend domain settings <ExternalLink size={13} />
                  </a>
                </details>
              </section>
            </div>
            <div className="integration-workflow">
              <h3>A clear path from sent to settled</h3>
              <div>
                <article>
                  <span>01</span>
                  <h4>Issue your invoice</h4>
                  <p>
                    Select a saved customer, vendor or B2B buyer, check the business GST details and issue the
                    document.
                  </p>
                </article>
                <article>
                  <span>02</span>
                  <h4>Share payment details</h4>
                  <p>
                    {manualOnly
                      ? 'Include your saved bank or QR details in the invoice email.'
                      : `Create a ${providerName} link in Payments and include it in the invoice email.`}
                  </p>
                </article>
                <article>
                  <span>03</span>
                  <h4>Follow every update</h4>
                  <p>
                    Check payment history and email attempts. A fully paid invoice keeps its number and
                    becomes final.
                  </p>
                </article>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
