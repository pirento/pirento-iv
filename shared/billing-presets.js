/**
 * Billing profiles: which units and pricing hints a business sees in the invoice editor
 * (general, legal, facility, elevator, space, jewellery, ecosystem). Used by server and browser.
 */

// Profile key -> display label, suggested units and editor hint.
export const BILLING_PROFILES = {
  general: {
    label: 'General business',
    units: ['Nos', 'Unit', 'Hour', 'Month', 'Project'],
    hint: 'Quantity × price per unit',
  },
  legal: {
    label: 'Legal & professional',
    units: ['Hour', 'Case', 'Draft', 'Visit', 'Month', 'Project'],
    hint: 'Bill for a consultation, case, document or retainer',
  },
  facility: {
    label: 'Facility & staffing',
    units: ['Person', 'Shift', 'Hour', 'Day', 'Month', 'Visit', 'Sq ft'],
    hint: 'People or units × periods × agreed rate',
  },
  elevator: {
    label: 'Elevator & maintenance',
    units: ['Lift', 'Visit', 'Month', 'Year', 'Piece', 'Project'],
    hint: 'Maintenance per lift, repair visits and spare parts',
  },
  space: {
    label: 'Space & interiors',
    units: ['Sq ft', 'Sq m', 'Seat', 'Room', 'Day', 'Month', 'Project', 'Unit'],
    hint: 'Area, seats, rooms or project charges',
  },
  jewellery: {
    label: 'Jewellery & precious metals',
    units: ['Piece', 'Gram', 'Carat', 'Milligram', 'Service'],
    hint: 'Net weight × metal rate, plus making and other charges',
  },
  ecosystem: {
    label: 'Ecosystem products',
    units: ['License', 'User', 'Month', 'Year', 'Project', 'Unit'],
    hint: 'Choose a business product, then its services or subscriptions',
  },
};
/** A business's billing profile: its saved choice, otherwise guessed from its name, else "general". */
export function billingProfileFor(org) {
  if (org.billingProfile) return org.billingProfile;
  if (/legal/i.test(org.name)) return 'legal';
  if (/facility/i.test(org.name)) return 'facility';
  if (/elevator/i.test(org.name)) return 'elevator';
  if (/space|inzario/i.test(org.name)) return 'space';
  if (/sarraf|jewel/i.test(org.name)) return 'jewellery';
  if (/ecosystem/i.test(org.name)) return 'ecosystem';
  return 'general';
}
// Starting values for a jewellery line (weight, purity, making charges, wastage ...).
export const emptyJewelleryPricing = () => ({
  mode: 'jewellery',
  jewellery: {
    grossWeight: 0,
    stoneWeight: 0,
    purity: '',
    makingChargeType: 'per_gram',
    makingCharge: 0,
    stoneAmount: 0,
    otherCharges: 0,
    wastagePercent: 0,
  },
});
// Default business products created for the PIRENTO ecosystem business on first run.
export const ECOSYSTEM_PRODUCT_NAMES = [
  'PIRENTO legal',
  'PIRENTO vault',
  'Pirento One',
  'Pirento Capital',
  'Pirento Blank',
  'Pirento AI',
  'Pirento Intern',
  'Pirento Green',
  'Giftox',
  'Bharat ID BY PIRENTO',
];
