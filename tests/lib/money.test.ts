import { describe, it, expect } from "vitest";
import { computeSplit, PLATFORM_FEE_PCT } from "../../lib/money";

describe("computeSplit", () => {
  it("defaults to the 20% platform fee", () => {
    expect(PLATFORM_FEE_PCT).toBe(0.2);
    const split = computeSplit(1000);
    expect(split).toEqual({
      gross: 1000,
      platformFee: 200,
      photographerPayout: 800,
    });
  });

  it("rounds the fee and payout to cents", () => {
    // 33.33 * 0.2 = 6.666 -> 6.67; payout 33.33 - 6.67 = 26.66
    const split = computeSplit(33.33);
    expect(split.platformFee).toBe(6.67);
    expect(split.photographerPayout).toBe(26.66);
  });

  it("keeps gross = fee + payout to the cent", () => {
    for (const gross of [9.99, 49.95, 100, 1234.56, 0.05]) {
      const { platformFee, photographerPayout } = computeSplit(gross);
      expect(
        parseFloat((platformFee + photographerPayout).toFixed(2)),
      ).toBe(parseFloat(gross.toFixed(2)));
    }
  });

  it("honours an explicit fee percentage", () => {
    const split = computeSplit(200, 0.1);
    expect(split.platformFee).toBe(20);
    expect(split.photographerPayout).toBe(180);
  });

  it("handles a zero amount", () => {
    expect(computeSplit(0)).toEqual({
      gross: 0,
      platformFee: 0,
      photographerPayout: 0,
    });
  });
});
