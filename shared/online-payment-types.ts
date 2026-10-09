export type OnlinePaymentLinkState =
  | 'creating'
  | 'created'
  | 'partially_paid'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'needs_review'
  | 'creation_unknown';

export interface OnlinePaymentConfiguration {
  provider: 'razorpay' | 'cashfree' | 'none';
  configured: boolean;
  keyConfigured: boolean;
  webhookConfigured: boolean;
  mode: 'test' | 'live' | 'unconfigured';
}

export interface OnlinePaymentLink {
  id: string;
  documentId: string;
  provider?: 'razorpay' | 'cashfree';
  providerId: string | null;
  referenceId: string;
  url: string;
  amount: number;
  amountReceived: number;
  currency: 'INR';
  state: OnlinePaymentLinkState;
  reviewReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnlinePaymentDetails {
  configuration: OnlinePaymentConfiguration;
  hasBlockingPaymentLink: boolean;
  links: OnlinePaymentLink[];
}
