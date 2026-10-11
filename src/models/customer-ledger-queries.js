import { receiptPaise, validReceiptPaise } from './money-expressions.js';

const ORGANIZATION_FIELDS = {
  _id: 0,
  id: 1,
  name: 1,
  legalName: 1,
  address: 1,
  gstin: 1,
  email: 1,
  phone: 1,
};
const CUSTOMER_FIELDS = {
  _id: 0,
  id: 1,
  organizationId: 1,
  name: 1,
  email: 1,
  phone: 1,
  address: 1,
  gstin: 1,
  active: 1,
};
const INVOICE_FIELDS = {
  _id: 0,
  id: 1,
  organizationId: 1,
  customerId: 1,
  kind: 1,
  status: 1,
  number: 1,
  issueDate: 1,
  dueDate: 1,
  createdAt: 1,
  updatedAt: 1,
  'totals.total': 1,
  amountPaid: 1,
  balanceDue: 1,
  'customerSnapshot.name': 1,
  'customerSnapshot.email': 1,
  'customerSnapshot.phone': 1,
  'customerSnapshot.address': 1,
  'customerSnapshot.gstin': 1,
  'installmentPlan.installments.id': 1,
  'installmentPlan.installments.label': 1,
  'installmentPlan.installments.amount': 1,
  'installmentPlan.installments.dueDate': 1,
};
const PAYMENT_FIELDS = {
  _id: 0,
  id: 1,
  documentId: 1,
  amount: 1,
  paidOn: 1,
  method: 1,
  reference: 1,
  createdAt: 1,
  providerPaidAt: 1,
  voidedAt: 1,
  voidReason: 1,
};

/** All joins start with authorized invoice IDs; contact names never establish ownership. */
export function createCustomerLedgerQueries(db) {
  function reader(options) {
    const collection = (name) => db.collection(name);
    // Older receipts may omit organizationId. Their authorized parent invoice still
    // establishes scope; an explicitly different organization is never accepted.
    const paymentOrganization = (organizationId) => ({
      $or: [{ organizationId }, { organizationId: null }],
    });
    return {
      organization: (id) =>
        collection('organizations').findOne({ id }, { ...options, projection: ORGANIZATION_FIELDS }),
      customer: (organizationId, id) =>
        collection('customers').findOne({ organizationId, id }, { ...options, projection: CUSTOMER_FIELDS }),
      customers: (organizationId) =>
        collection('customers').find({ organizationId }, { ...options, projection: CUSTOMER_FIELDS }),
      invoices(organizationId, customerId, { withReceiptSummary = true } = {}) {
        const filter = {
          organizationId,
          kind: 'invoice',
          ...(customerId === undefined ? {} : { customerId }),
        };
        // Statements read the actual receipts once in the same snapshot and
        // derive their summaries with the shared JavaScript calculations.
        if (!withReceiptSummary)
          return collection('documents')
            .find(filter, { ...options, projection: INVOICE_FIELDS })
            .batchSize(100);
        return collection('documents').aggregate(
          [
            { $match: filter },
            { $project: INVOICE_FIELDS },
            {
              $lookup: {
                from: 'payments',
                let: {
                  documentId: '$id',
                  receivable: { $in: ['$status', ['sent', 'partially_paid', 'paid']] },
                },
                pipeline: [
                  {
                    $match: {
                      $expr: { $and: ['$$receivable', { $eq: ['$documentId', '$$documentId'] }] },
                      ...paymentOrganization(organizationId),
                    },
                  },
                  { $set: { ledgerReceiptPaise: receiptPaise } },
                  {
                    $group: {
                      _id: null,
                      receiptCount: { $sum: 1 },
                      activePaise: {
                        $sum: {
                          $cond: [
                            { $eq: [{ $ifNull: ['$voidedAt', null] }, null] },
                            '$ledgerReceiptPaise',
                            0,
                          ],
                        },
                      },
                      invalidAmounts: {
                        $sum: { $cond: [validReceiptPaise('$ledgerReceiptPaise'), 0, 1] },
                      },
                    },
                  },
                ],
                as: 'receiptSummary',
              },
            },
          ],
          { ...options, batchSize: 100 },
        );
      },
      payments(organizationId, documentIds) {
        return collection('payments')
          .find(
            { documentId: { $in: documentIds }, ...paymentOrganization(organizationId) },
            { ...options, projection: PAYMENT_FIELDS },
          )
          .batchSize(200);
      },
      eventCounts(documentIds) {
        return collection('document_events').aggregate(
          [
            {
              $match: {
                documentId: { $in: documentIds },
                type: { $in: ['payment_recorded', 'payment_voided'] },
              },
            },
            { $group: { _id: { documentId: '$documentId', type: '$type' }, count: { $sum: 1 } } },
          ],
          options,
        );
      },
    };
  }

  return {
    async read(action) {
      const inherited = db.options();
      if (inherited.session) return action(reader(inherited));
      // Snapshot reads give one consistent invoice/receipt view without invoking
      // the workspace transaction helper, which deliberately writes a lock row.
      const session = db.client.startSession({ snapshot: true });
      try {
        return await action(reader({ ...inherited, session }));
      } finally {
        await session.endSession();
      }
    },
  };
}
