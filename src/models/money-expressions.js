/** MongoDB aggregation helpers that turn rupee amounts into whole paise exactly like the JavaScript code does. */

/**
 * MongoDB expression matching Math.round(amount * 100), including legacy amounts.
 * $round uses ties-to-even; floor(value + 0.5) changes large odd safe integers.
 * Compare the fractional part before adding the rounding increment instead.
 */
export function roundedPaise(amount) {
  return {
    $let: {
      vars: { scaled: { $multiply: [amount, 100] } },
      in: {
        $let: {
          vars: { lower: { $floor: '$$scaled' } },
          in: {
            $add: ['$$lower', { $cond: [{ $gte: [{ $subtract: ['$$scaled', '$$lower'] }, 0.5] }, 1, 0] }],
          },
        },
      },
    },
  };
}

// The guard lets the query report corrupt records without a MongoDB type error.
// Every receipt aggregation must also count invalid amounts using the validator.
export const receiptPaise = roundedPaise({ $cond: [{ $isNumber: '$amount' }, '$amount', 0] });

/** MongoDB expression: true when the stored amount is a plain number and its paise value is 0 or more and a safe integer. */
export function validReceiptPaise(paise) {
  return {
    $and: [
      // These BSON types are read as JS numbers. Decimal128 objects, strings,
      // non-finite amounts and unsafe rounded paise require source-record review.
      { $in: [{ $type: '$amount' }, ['double', 'int', 'long']] },
      { $gte: [paise, 0] },
      { $lte: [paise, Number.MAX_SAFE_INTEGER] },
    ],
  };
}
