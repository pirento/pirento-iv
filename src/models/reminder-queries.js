/** Candidate selection only; shared financial rules recheck every returned invoice. */
export function reminderCandidateFilter(organizationId, dueDates) {
  return {
    organizationId,
    kind: 'invoice',
    status: { $in: ['sent', 'partially_paid'] },
    $or: [{ dueDate: { $in: dueDates } }, { 'installmentPlan.installments.dueDate': { $in: dueDates } }],
  };
}
