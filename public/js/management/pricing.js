import { linePriceBreakdown, money } from '/shared/types.js';

export function readPricing(form) {
  const value = (key) => form.elements.namedItem(key)?.value;
  const number = (key) => Number(value(key));
  const mode = value('pricingMode') || 'standard';
  if (mode === 'standard') return undefined;
  if (mode === 'recurring')
    return { mode, periods: number('periods'), periodUnit: value('periodUnit') || 'Month' };
  return {
    mode: 'jewellery',
    jewellery: {
      grossWeight: number('grossWeight'),
      stoneWeight: number('stoneWeight'),
      purity: value('purity') || '',
      makingChargeType: value('makingChargeType'),
      makingCharge: number('makingCharge'),
      stoneAmount: number('stoneAmount'),
      otherCharges: number('otherCharges'),
      wastagePercent: number('wastagePercent'),
    },
  };
}

export function validatePricing(pricing) {
  if (!pricing || pricing.mode === 'standard') return '';
  if (pricing.mode === 'recurring') {
    return !Number.isFinite(pricing.periods) || pricing.periods <= 0 || pricing.periods > 1200
      ? 'Enter periods above zero and no more than 1,200.'
      : '';
  }
  const jewellery = pricing.jewellery;
  if (!jewellery) return 'Add the jewellery weight and making details.';
  if (
    !Number.isFinite(jewellery.grossWeight) ||
    jewellery.grossWeight <= 0 ||
    jewellery.grossWeight > 1000000
  )
    return 'Gross weight per item must be above zero and no more than 1,000,000 g.';
  if (
    !Number.isFinite(jewellery.stoneWeight) ||
    jewellery.stoneWeight < 0 ||
    jewellery.stoneWeight >= jewellery.grossWeight
  )
    return 'Stone weight must be non-negative and less than gross weight, leaving a positive net metal weight.';
  if (
    [jewellery.makingCharge, jewellery.stoneAmount, jewellery.otherCharges].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100000000,
    )
  )
    return 'Making, stone and other charges must be between zero and ₹10 crore.';
  if (
    !Number.isFinite(jewellery.wastagePercent) ||
    jewellery.wastagePercent < 0 ||
    jewellery.wastagePercent > 100 ||
    (jewellery.makingChargeType === 'percent' && jewellery.makingCharge > 100)
  )
    return 'Wastage and percentage making charges must be between 0% and 100%.';
  return '';
}

export function bindPricing(form, { quantity = 1, onChange } = {}) {
  const root = form.querySelector('[data-pricing]');
  if (!root) return;
  const value = (key) => form.elements.namedItem(key)?.value;
  const update = () => {
    const pricing = readPricing(form);
    const mode = pricing?.mode || 'standard';
    root.querySelectorAll('[data-pricing-mode]').forEach((section) => {
      const active = section.dataset.pricingMode === mode;
      section.hidden = !active;
      section.querySelectorAll('input,select').forEach((control) => {
        control.disabled = !active;
      });
    });
    const rate = Number(value('rate')) || 0;
    const unit = value('unit') || 'Unit';
    const count = typeof quantity === 'function' ? quantity() : quantity;
    const details = linePriceBreakdown({ quantity: count, rate, pricing });
    const net = root.querySelector('[data-net-weight]');
    if (net) net.textContent = `${Number(details.netWeight.toFixed(6))} g`;
    root.querySelectorAll('[data-price-part]').forEach((element) => {
      element.textContent = money(details[element.dataset.pricePart]);
    });
    const formula = root.querySelector('[data-price-formula]');
    if (formula)
      formula.textContent = `${count} ${unit} × ${pricing?.periods || 1} ${(pricing?.periodUnit || 'Month').toLowerCase()} × ${money(rate)} = ${money(details.total)}`;
    const making = form.elements.namedItem('makingCharge');
    if (making) making.max = value('makingChargeType') === 'percent' ? '100' : '100000000';
    const label = root.querySelector('[data-making-unit]');
    if (label)
      label.textContent =
        value('makingChargeType') === 'percent'
          ? '%'
          : value('makingChargeType') === 'fixed'
            ? '₹/item'
            : '₹/g';
    const rateLabel = form.querySelector('[data-rate-label]');
    if (rateLabel)
      rateLabel.textContent =
        mode === 'jewellery'
          ? 'Metal rate (₹/g)'
          : mode === 'recurring'
            ? `Rate per ${unit} / ${(pricing.periodUnit || 'Month').toLowerCase()} (₹)`
            : 'Selling price (₹)';
    onChange?.(pricing);
  };
  form.addEventListener('input', update);
  form.addEventListener('change', (event) => {
    if (event.target.name === 'pricingMode') {
      if (event.target.value === 'recurring') {
        form.elements.namedItem('periods').value = '1';
        form.elements.namedItem('periodUnit').value = 'Month';
      } else if (event.target.value === 'jewellery') {
        const unit = form.elements.namedItem('unit');
        if (unit) unit.value = 'Piece';
        for (const key of [
          'grossWeight',
          'stoneWeight',
          'makingCharge',
          'stoneAmount',
          'otherCharges',
          'wastagePercent',
        ])
          form.elements.namedItem(key).value = '0';
        form.elements.namedItem('purity').value = '';
        form.elements.namedItem('makingChargeType').value = 'per_gram';
      }
    }
    update();
  });
  update();
  return update;
}
