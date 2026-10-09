export type EmailKind = 'invoice' | 'payment_received' | 'payment_paid' | 'payment_failed' | 'password_reset';
export type EmailStatus = 'held' | 'queued' | 'sending' | 'sent' | 'failed';

export interface EmailMessage {
  id: string;
  documentId: string | null;
  kind: EmailKind;
  to: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  lastError: string;
  providerId: string;
  hasPaymentLink: boolean;
  canRetry: boolean;
}

export interface EmailIntegrationStatus {
  organizationId?: string;
  replyTo?: string;
  configured: boolean;
  provider: 'resend';
  from: string;
  automationEnabled: boolean;
  reason: string;
}

export interface EmailSendResult {
  message: EmailMessage;
}
