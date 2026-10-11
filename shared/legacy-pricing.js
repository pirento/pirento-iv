/**
 * Historical documents without a saved rounding-policy marker retain the
 * original line display. Never use this for a newly calculated document.
 * Saved invoice totals remain authoritative and are not recalculated here.
 */
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function legacyLinePriceBreakdown(item) {
  const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
  const rate = Number.isFinite(item.rate) ? item.rate : 0;
  const pricing = item.pricing;
  const jewellery = pricing?.mode === 'jewellery' ? pricing.jewellery : undefined;
  const periods = pricing?.mode === 'recurring' ? (pricing.periods ?? 1) : 1;
  const netWeight = jewellery ? Math.max(0, jewellery.grossWeight - jewellery.stoneWeight) : 0;
  const base = round(quantity * (jewellery ? netWeight : periods) * rate);
  const making = jewellery
    ? round(
        jewellery.makingChargeType === 'percent'
          ? (base * jewellery.makingCharge) / 100
          : quantity * jewellery.makingCharge * (jewellery.makingChargeType === 'per_gram' ? netWeight : 1),
      )
    : 0;
  const wastage = jewellery ? round((base * jewellery.wastagePercent) / 100) : 0;
  const stones = jewellery ? round(quantity * jewellery.stoneAmount) : 0;
  const other = jewellery ? round(quantity * jewellery.otherCharges) : 0;
  return {
    base,
    making,
    wastage,
    stones,
    other,
    netWeight,
    periods,
    total: round(base + making + wastage + stones + other),
  };
}
