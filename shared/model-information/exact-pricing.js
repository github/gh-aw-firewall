'use strict';

// Rational arithmetic is needed for provider batch sizes that do not divide a
// power of ten. Public rate objects remain numeric; exact rates stay private.
const exactRates = new WeakMap();
const MAX_DIGITS = 4096;
const ZERO = Object.freeze({ n: 0n, d: 1n });
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
function rational(n, d = 1n) {
  if (n < 0n || d <= 0n ||
      n.toString().length > MAX_DIGITS || d.toString().length > MAX_DIGITS) {
    throw new Error('pricing_decimal_out_of_range');
  }
  const divisor = gcd(n, d);
  return Object.freeze({ n: n / divisor, d: d / divisor });
}
function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('pricing_decimal_invalid');
  const text = String(value);
  if (text.length > 420) throw new Error('pricing_decimal_out_of_range');
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,3}))?$/.exec(text.trim());
  if (!match) throw new Error('pricing_decimal_invalid');
  const integer = match[1] || '0';
  const fraction = match[2] || match[3] || '';
  const exponent = Number(match[4] || 0) - fraction.length;
  if (Math.abs(exponent) > 400 || integer.length + fraction.length > 400) {
    throw new Error('pricing_decimal_out_of_range');
  }
  const n = BigInt(integer + fraction);
  return exponent >= 0 ? rational(n * 10n ** BigInt(exponent))
    : rational(n, 10n ** BigInt(-exponent));
}
function add(a, b) { return rational(a.n * b.d + b.n * a.d, a.d * b.d); }
function multiply(a, b) { return rational(a.n * b.n, a.d * b.d); }
function divide(a, b) { return rational(a.n * b.d, a.d * b.n); }
function compare(a, b) {
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function number(a, places = 6) {
  if (!Number.isInteger(places) || places < 0 || places > 6) throw new Error('pricing_decimal_invalid_places');
  const scale = 10n ** BigInt(places);
  // Nonnegative charges: nearest, with exact ties toward positive infinity.
  const units = (2n * a.n * scale + a.d) / (2n * a.d);
  const digits = units.toString().padStart(places + 1, '0');
  const result = Number(places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits);
  if (!Number.isFinite(result)) throw new Error('pricing_decimal_output_out_of_range');
  return result;
}
function rate(pricing, field) {
  if (pricing[field] === null) return null;
  return exactRates.get(pricing)?.[field] || decimal(pricing[field]);
}
function rates(values, transform = value => decimal(value)) {
  const result = {};
  const exact = {};
  for (const [field, value] of Object.entries(values)) {
    if (field === 'threshold') { result[field] = value; continue; }
    if (value === null) { result[field] = null; continue; }
    const parsed = exactRates.get(values)?.[field] || transform(value);
    // This projection is for existing numeric metadata only, never accounting.
    const projection = Number(`${parsed.n / parsed.d}.${(
      (parsed.n % parsed.d) * 10n ** 400n / parsed.d
    ).toString().padStart(400, '0')}`);
    if (!Number.isFinite(projection)) throw new Error('pricing_decimal_output_out_of_range');
    result[field] = projection;
    exact[field] = parsed;
  }
  exactRates.set(result, exact);
  return result;
}
function fromExact(values) { return rates(values, value => value); }

module.exports = { ZERO, decimal, add, multiply, divide, compare, number, rate, rates, fromExact };
