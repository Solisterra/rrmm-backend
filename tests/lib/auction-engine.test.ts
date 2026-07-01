import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeAuction, makeBid } from "../helpers/factories";

// db + notification mocks are referenced by the (lazily-evaluated) mock factories
// below; the SUT is imported dynamically in beforeEach, after these are defined.
const db = makeSupabaseHarness();
const notifications = {
  notifyOutbid: vi.fn(),
  notifyAuctionWon: vi.fn(),
  notifyAuctionLost: vi.fn(),
  notifyAuctionSold: vi.fn(),
  notifyWatchlistUrgent: vi.fn(),
};

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/notifications", () => notifications);

let engine: typeof import("../../lib/auction-engine");

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  engine = await import("../../lib/auction-engine");
});

describe("placeBid — validation", () => {
  it("rejects when the auction is missing", async () => {
    db.setResolver(() => ({ data: null, error: { message: "x" } }));
    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "u",
      amount: 100,
    });
    expect(r.error).toBe("Auction not found");
  });

  it("rejects when the auction is not active", async () => {
    db.setResolver(() => ({
      data: makeAuction({ status: "sold" }),
      error: null,
    }));
    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "u",
      amount: 9999,
    });
    expect(r.error).toBe("Auction is sold");
  });

  it("rejects a bid placed after the auction ended", async () => {
    db.setResolver(() => ({
      data: makeAuction({
        status: "active",
        ends_at: new Date(Date.now() - 1000).toISOString(),
      }),
      error: null,
    }));
    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "u",
      amount: 9999,
    });
    expect(r.error).toBe("Auction has ended");
  });

  it("rejects a bid below the reserve when there are no bids yet", async () => {
    db.setResolver(() => ({
      data: makeAuction({ status: "active", current_bid: 0, reserve_price: 1000 }),
      error: null,
    }));
    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "u",
      amount: 500,
    });
    expect(r.error).toBe("Bid must be at least $1000");
  });

  it("rejects the photographer bidding on their own listing", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            status: "active",
            current_bid: 0,
            reserve_price: 1000,
            photographer_id: "me",
          }),
          error: null,
        };
      return { data: null, error: null };
    });
    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "me",
      amount: 1000,
    });
    expect(r.error).toBe("You cannot bid on your own listing.");
  });

  it("accepts a valid first bid and records it as winning", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            status: "active",
            current_bid: 0,
            reserve_price: 1000,
            ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
          error: null,
        };
      if (table === "bids" && terminal === "single")
        return { data: null, error: null }; // no current winner
      return { data: null, error: null };
    });

    const r = await engine.placeBid({
      auctionId: "auction-1",
      bidderId: "buyer-9",
      amount: 1000,
    });

    expect(r.success).toBe(true);
    expect(r.winning).toBe(true);
    expect(r.currentBid).toBe(1000);

    const bidInsert = db.inserts("bids")[0];
    expect(bidInsert).toMatchObject({
      auction_id: "auction-1",
      bidder_id: "buyer-9",
      amount: 1000,
      is_winning: true,
    });
    // current_bid is advanced on the auction row.
    expect(db.updates("auctions").some((u) => u.current_bid === 1000)).toBe(true);
  });
});

describe("closeAuction — branch selection", () => {
  function resolveWith(auction: ReturnType<typeof makeAuction>, winner: unknown) {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return { data: auction, error: null };
      if (table === "bids" && terminal === "single")
        return { data: winner, error: null };
      if (table === "transactions" && terminal === "single")
        return { data: { id: "tx-9" }, error: null };
      return { data: null, error: null }; // bids await (notify), updates, inserts
    });
  }

  it("moves to marketplace when there is no winning bid but a fallback price", async () => {
    resolveWith(
      makeAuction({ status: "active", fallback_price: 250 }),
      null,
    );
    const r = await engine.closeAuction("auction-1");
    expect(r).toMatchObject({ success: true, sold: false, marketplace: true });

    const update = db.updates("auctions")[0];
    expect(update.status).toBe("marketplace");
    expect(update.marketplace_since).toBeTypeOf("string");
  });

  it("marks unsold when there is no winning bid and no fallback price", async () => {
    resolveWith(
      makeAuction({ status: "active", fallback_price: null }),
      null,
    );
    const r = await engine.closeAuction("auction-1");
    expect(r).toMatchObject({ success: true, sold: false });
    expect(r.marketplace).toBeUndefined();
    expect(db.updates("auctions")[0].status).toBe("unsold");
  });

  it("moves to marketplace when the top bid is below reserve + a fallback exists", async () => {
    resolveWith(
      makeAuction({ status: "active", reserve_price: 1000, fallback_price: 200 }),
      makeBid({ amount: 500 }),
    );
    const r = await engine.closeAuction("auction-1");
    expect(r.marketplace).toBe(true);
    expect(db.updates("auctions")[0].status).toBe("marketplace");
  });

  it("sells with the correct split + transaction when the reserve is met", async () => {
    resolveWith(
      makeAuction({ status: "active", reserve_price: 1000 }),
      makeBid({ id: "bid-7", bidder_id: "buyer-2", amount: 2000 }),
    );
    const r = await engine.closeAuction("auction-1");

    expect(r).toMatchObject({
      success: true,
      sold: true,
      transactionId: "tx-9",
      salePrice: 2000,
      photographerPayout: 1600,
    });

    const update = db.updates("auctions")[0];
    expect(update).toMatchObject({
      status: "sold",
      sale_price: 2000,
      platform_fee: 400,
      photographer_payout: 1600,
      buyer_id: "buyer-2",
      winning_bid_id: "bid-7",
    });

    const tx = db.inserts("transactions")[0];
    expect(tx).toMatchObject({
      auction_id: "auction-1",
      buyer_id: "buyer-2",
      gross_amount: 2000,
      platform_fee: 400,
      photographer_payout: 1600,
    });

    expect(notifications.notifyAuctionWon).toHaveBeenCalledOnce();
    expect(notifications.notifyAuctionSold).toHaveBeenCalledOnce();
  });

  it("refuses to close an auction that is not active", async () => {
    resolveWith(makeAuction({ status: "marketplace" }), null);
    const r = await engine.closeAuction("auction-1");
    expect(r.error).toBe("Cannot close auction");
  });
});
