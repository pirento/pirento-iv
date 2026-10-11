/**
 * Convert an already-denominated rupee amount to whole paise without rounding
 * fractional paise. The tolerance covers only normal floating-point noise.
 * Return NaN for invalid inputs so callers can provide a field-specific error.
 */
export function wholePaise(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return NaN;
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) return NaN;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  return Math.abs(scaled - rounded) <= tolerance ? rounded : NaN;
}
