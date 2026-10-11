/**
 * Small exact-decimal arithmetic for pricing in Node and the browser.
 *
 * Inputs keep the decimal value of a finite JavaScript number's canonical
 * string, including exponent notation. Arithmetic stays in BigInt until a
 * result is exposed to the existing number-based UI/storage contract. This
 * cannot recover digits already lost before a value became a Number.
 *
 * Rounding is decimal half-up: a tie moves away from zero. Invalid inputs
 * propagate as NaN so an incomplete editor field never causes a BigInt error.
 */
class Decimal {
  constructor(coefficient, scale) {
    this.coefficient = coefficient;
    this.scale = scale;
  }

  plus(value) {
    const other = decimal(value);
    if (this.coefficient === null || other.coefficient === null) return invalid;
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(
      this.coefficient * 10n ** BigInt(scale - this.scale) +
        other.coefficient * 10n ** BigInt(scale - other.scale),
      scale,
    );
  }

  minus(value) {
    const other = decimal(value);
    if (other.coefficient === null) return invalid;
    return this.plus(new Decimal(-other.coefficient, other.scale));
  }

  times(value) {
    const other = decimal(value);
    if (this.coefficient === null || other.coefficient === null) return invalid;
    return new Decimal(this.coefficient * other.coefficient, this.scale + other.scale);
  }

  round(places = 2) {
    if (!Number.isInteger(places) || places < 0)
      throw new RangeError('Decimal places must be a nonnegative integer.');
    if (this.coefficient === null || this.scale <= places) return this;
    const divisor = 10n ** BigInt(this.scale - places);
    const absolute = this.coefficient < 0n ? -this.coefficient : this.coefficient;
    const rounded = absolute / divisor + (2n * (absolute % divisor) >= divisor ? 1n : 0n);
    return new Decimal(this.coefficient < 0n ? -rounded : rounded, places);
  }

  isNegative() {
    return this.coefficient !== null && this.coefficient < 0n;
  }

  toNumber() {
    // Parsing the exponent as a whole avoids overflow/underflow in an
    // intermediate Number(coefficient) / 10 ** scale conversion.
    return this.coefficient === null ? NaN : Number(`${this.coefficient}e-${this.scale}`);
  }
}

const invalid = new Decimal(null, 0);

export function decimal(value) {
  if (value instanceof Decimal) return value;
  if (!Number.isFinite(value)) return invalid;
  const [mantissa, exponent = '0'] = String(Math.abs(value)).split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  let coefficient = BigInt(integer + fraction);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return new Decimal(value < 0 ? -coefficient : coefficient, scale);
}
