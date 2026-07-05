import { describe, it, expect } from "vitest";
import {
  formatAuction,
  formatMarketItem,
  formatArchivedListing,
  formatApplication,
  formatTransaction,
} from "../../lib/format";
import {
  makeAuction,
  makeApplication,
  makeTransaction,
} from "../helpers/factories";

const HOUR = 60 * 60 * 1000;

// formatTransaction's param narrows the optional joined `buyer`/`auctions` more
// tightly than DbTransaction declares them, so a bare row needs this assertion.
type TxRow = Parameters<typeof formatTransaction>[0];

describe("formatAuction", () => {
  it("derives photographer name from the joined handle", () => {
    const out = formatAuction(
      makeAuction({ users: { handle: "rocketcam" } }),
    );
    expect(out.photographer).toBe("rocketcam");
  });

  it("falls back to display_name then Unknown", () => {
    expect(
      formatAuction(makeAuction({ users: { display_name: "Cam" } }))
        .photographer,
    ).toBe("Cam");
    expect(formatAuction(makeAuction({ users: undefined })).photographer).toBe(
      "Unknown",
    );
  });

  it("minBid is the reserve when there are no bids", () => {
    const out = formatAuction(
      makeAuction({ current_bid: 0, reserve_price: 750 }),
    );
    expect(out.minBid).toBe(750);
    expect(out.currentBid).toBe(0);
  });

  it("minBid is current bid + 8% (ceil) once bidding starts", () => {
    const out = formatAuction(makeAuction({ current_bid: 1000 }));
    expect(out.minBid).toBe(1080);
  });

  it("maps a known category to its emoji and unknown to the fallback", () => {
    expect(formatAuction(makeAuction({ category: "Launch Event" })).emoji).toBe(
      "🚀",
    );
    expect(
      formatAuction(
        makeAuction({ category: "Nope" as unknown as "Launch Event" }),
      ).emoji,
    ).toBe("🌌");
  });

  it("flags freshly created auctions as new", () => {
    expect(formatAuction(makeAuction()).isNew).toBe(true);
    expect(
      formatAuction(
        makeAuction({
          created_at: new Date(Date.now() - 5 * HOUR).toISOString(),
        }),
      ).isNew,
    ).toBe(false);
  });

  it("computes minutesLeft from ends_at and clamps at zero", () => {
    const future = formatAuction(
      makeAuction({ ends_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
    );
    expect(future.minutesLeft).toBeGreaterThanOrEqual(29);
    expect(future.minutesLeft).toBeLessThanOrEqual(30);

    const past = formatAuction(
      makeAuction({ ends_at: new Date(Date.now() - HOUR).toISOString() }),
    );
    expect(past.minutesLeft).toBe(0);
  });
});

describe("formatMarketItem", () => {
  it("uses fallback_price as the price, never the reserve", () => {
    const out = formatMarketItem(
      makeAuction({ status: "marketplace", reserve_price: 999, fallback_price: 250 }),
    );
    expect(out.price).toBe(250);
  });

  it("surfaces license_count as the licensed social-proof count", () => {
    expect(
      formatMarketItem(makeAuction({ license_count: 12 })).licensed,
    ).toBe(12);
  });

  it("treats price 0 when fallback_price is null", () => {
    expect(formatMarketItem(makeAuction({ fallback_price: null })).price).toBe(
      0,
    );
  });

  it("isNew tracks marketplace_since (24h), not created_at", () => {
    const old = new Date(Date.now() - 10 * 24 * HOUR).toISOString();
    const recent = formatMarketItem(
      makeAuction({ created_at: old, marketplace_since: new Date().toISOString() }),
    );
    expect(recent.isNew).toBe(true);

    const stale = formatMarketItem(
      makeAuction({
        created_at: new Date().toISOString(),
        marketplace_since: new Date(Date.now() - 2 * 24 * HOUR).toISOString(),
      }),
    );
    expect(stale.isNew).toBe(false);
  });
});

describe("formatTransaction", () => {
  it("maps gross/payout to salePrice/net", () => {
    const out = formatTransaction(
      makeTransaction({ gross_amount: 1500, photographer_payout: 1200 }) as TxRow,
    );
    expect(out.salePrice).toBe(1500);
    expect(out.net).toBe(1200);
  });

  it("collapses payout_status into paid/pending", () => {
    expect(
      formatTransaction(
        makeTransaction({ payout_status: "paid" }) as TxRow,
      ).status,
    ).toBe("paid");
    for (const s of ["in_transit", "pending", "failed"] as const) {
      expect(
        formatTransaction(makeTransaction({ payout_status: s }) as TxRow).status,
      ).toBe("pending");
    }
  });

  it("prefers the joined auction title and buyer name", () => {
    const out = formatTransaction({
      ...makeTransaction(),
      auctions: { title: "Booster Catch", category: "Milestone" },
      buyer: { display_name: "Ada" },
    });
    expect(out.title).toBe("Booster Catch");
    expect(out.buyer).toBe("Ada");
    expect(out.emoji).toBe("🏆");
  });
});

describe("formatArchivedListing", () => {
  it("shapes an archived row as a relist candidate", () => {
    const out = formatArchivedListing(
      makeAuction({
        status: "archived",
        fallback_price: 40,
        category: "Scenic",
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
    );
    expect(out).toMatchObject({
      id: "auction-1",
      photographer_id: "photographer-1",
      category: "Scenic",
      emoji: "🌅",
      price: 40,
      archivedAt: "2026-06-01T00:00:00.000Z",
    });
    // No live-auction fields and, critically, no full-res URL leak.
    expect(out).not.toHaveProperty("currentBid");
    expect(out).not.toHaveProperty("full_url");
  });

  it("defaults a missing fallback price to 0", () => {
    const out = formatArchivedListing(
      makeAuction({ status: "archived", fallback_price: null }),
    );
    expect(out.price).toBe(0);
  });
});

describe("formatApplication", () => {
  it("maps the application shape and formats the date", () => {
    const out = formatApplication(
      makeApplication({ channel_name: "Space Daily", note: "hi" }),
    );
    expect(out.channel).toBe("Space Daily");
    expect(out.note).toBe("hi");
    expect(out.platforms).toHaveLength(1);
    expect(out.appliedAt).toBeTypeOf("string");
  });
});
