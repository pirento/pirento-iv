/**
 * Receipt correction API: POST /api/payments/:id/void cancels a manual receipt with a reason.
 * The receipt stays in history (never deleted) and the invoice balance is recalculated.
 */

import { transactionForRecord } from '../../services/transaction-ownership.js';
import { voidPaymentSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  const { db, online, now, getDocument, getPayment, addEvent, paymentDetails, updatePaymentBalance } =
    context;
  return {
    // POST /api/payments/:id/void
    voidPayment: async (req, res) => {
      const { reason } = voidPaymentSchema.parse(req.body);
      // Historical receipts can omit organizationId; their persisted parent
      // invoice remains authoritative for choosing and checking the write scope.
      const initialPayment = await getPayment(req.params.id);
      if (typeof initialPayment.documentId !== 'string' || !initialPayment.documentId)
        throw new HttpError(
          409,
          'The saved payment has no valid parent invoice. Review it before changing it.',
        );
      const details = await transactionForRecord(
        db,
        () => getDocument(initialPayment.documentId),
        async (document) => {
          const user = res.locals.user;
          if (user && user.role !== 'admin' && !user.organizationIds?.includes(document.organizationId))
            throw new HttpError(403, 'Your account does not have access to this organization or action.');
          const payment = await getPayment(req.params.id);
          if (
            payment.documentId !== document.id ||
            (payment.organizationId != null && payment.organizationId !== document.organizationId)
          )
            throw new HttpError(409, 'The saved payment does not belong to this invoice business.');
          if (/^(razorpay|cashfree):/.test(payment.requestId))
            throw new HttpError(
              409,
              'Verified gateway receipts cannot be manually voided. Handle a refund with the payment provider and reconcile it separately.',
            );
          await online.assertManualChangesAllowed(payment.documentId);
          if (payment.voidedAt) {
            if (reason !== payment.voidReason)
              throw new HttpError(409, 'This payment is already voided. Its original reason is preserved.');
            return await paymentDetails(document.id);
          }
          const voided = {
            ...payment,
            voidedAt: now().toISOString(),
            voidReason: reason,
          };
          await db.models.payments.save(voided);
          await addEvent(
            document.id,
            'payment_voided',
            `Payment of INR ${payment.amount.toFixed(2)} voided. Reason: ${reason}`,
          );
          if (document.finalizedAt)
            await addEvent(
              document.id,
              'invoice_reopened',
              'Finalized invoice reopened after a payment was voided. Prior finalization remains in this audit history.',
            );
          await updatePaymentBalance(document, false, true);
          return await paymentDetails(document.id);
        },
      );
      res.json(details);
    },
  };
}
