// ── Money math ────────────────────────────────────────────────────────────────
// The single source of truth for the platform-fee split. Both the auction
// settlement (auction-engine.closeAuction) and the marketplace purchase endpoint
// must compute the photographer's net the same way, rounded to cents. Keeping it
// here makes the split independently testable and impossible to drift between the
// two payment paths. (Stripe's checkout helper rounds on integer cents separately,
// which is a deliberate, different concern.)

export const PLATFORM_FEE_PCT = parseFloat(
  process.env.PLATFORM_FEE_PCT || "0.20",
);

export interface MoneySplit {
  /** What the buyer pays. */
  gross: number;
  /** Platform commission, rounded to 2 decimals. */
  platformFee: number;
  /** What the photographer receives (gross − fee), rounded to 2 decimals. */
  photographerPayout: number;
}

/**
 * Split a gross amount into platform fee + photographer payout, rounding each to
 * cents. `feePct` defaults to the configured platform rate.
 */
export function computeSplit(
  gross: number,
  feePct: number = PLATFORM_FEE_PCT,
): MoneySplit {
  const platformFee = parseFloat((gross * feePct).toFixed(2));
  const photographerPayout = parseFloat((gross - platformFee).toFixed(2));
  return { gross, platformFee, photographerPayout };
}
