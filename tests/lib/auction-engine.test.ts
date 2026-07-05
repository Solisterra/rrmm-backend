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
  notifyContentArchived: vi.fn(),
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

describe("archiveListing — race-safe archive of a stale marketplace listing", () => {
  // The archive flip is a conditional UPDATE ... .select() returning the affected
  // rows. The harness settles awaited chains via the resolver, so we hand back a
  // 1-row array for "archived" and an empty array for "race lost / already gone".
  function resolveArchive(rows: unknown[]) {
    db.setResolver(({ table, ops }: ResolveCtx) =>
      table === "auctions" && ops.some((o) => o.m === "update")
        ? { data: rows, error: null }
        : { data: null, error: null },
    );
  }

  it("flips status to archived and reverts rights when the row still qualifies", async () => {
    resolveArchive([
      { id: "auction-1", photographer_id: "photographer-1", title: "Old Shot" },
    ]);

    const r = await engine.archiveListing("auction-1");
    expect(r).toEqual({ success: true, archived: true });

    const update = db.updates("auctions")[0];
    expect(update).toMatchObject({
      status: "archived",
      rights_transferred: false,
    });
  });

  it("gates the flip on status='marketplace' AND license_count=0 (the race guard)", async () => {
    resolveArchive([
      { id: "auction-1", photographer_id: "photographer-1", title: "Old Shot" },
    ]);
    await engine.archiveListing("auction-1");

    const entry = db.log.find(
      (e) => e.table === "auctions" && e.ops.some((o) => o.m === "update"),
    );
    const eqArgs = entry!.ops.filter((o) => o.m === "eq").map((o) => o.args);
    expect(eqArgs).toContainEqual(["id", "auction-1"]);
    expect(eqArgs).toContainEqual(["status", "marketplace"]);
    expect(eqArgs).toContainEqual(["license_count", 0]);
  });

  it("notifies the photographer that their listing was archived", async () => {
    resolveArchive([
      { id: "auction-1", photographer_id: "ph-9", title: "Old Shot" },
    ]);
    await engine.archiveListing("auction-1");

    expect(notifications.notifyContentArchived).toHaveBeenCalledOnce();
    expect(notifications.notifyContentArchived).toHaveBeenCalledWith({
      photographerId: "ph-9",
      auctionId: "auction-1",
    });
  });

  it("is a no-op when the conditional UPDATE matches no row (in-flight purchase / already archived)", async () => {
    resolveArchive([]); // license_count went > 0, or status already 'archived'

    const r = await engine.archiveListing("auction-1");
    expect(r).toEqual({ archived: false });
    expect(r.success).toBeUndefined();
    expect(notifications.notifyContentArchived).not.toHaveBeenCalled();
  });
});

describe("processStaleMarketplaceListings — the cron sweep", () => {
  it("filters candidates on marketplace + 0 licenses + age, then archives each", async () => {
    db.setResolver(({ table, ops }: ResolveCtx) => {
      if (table !== "auctions") return { data: null, error: null };
      if (ops.some((o) => o.m === "update")) {
        // Echo the id from the conditional update so notify gets a realistic owner.
        const id = ops.find((o) => o.m === "eq" && o.args[0] === "id")?.args[1];
        return {
          data: [{ id, photographer_id: `ph-${id}`, title: "Old Shot" }],
          error: null,
        };
      }
      // Candidate pre-select.
      return { data: [{ id: "auction-1" }, { id: "auction-2" }], error: null };
    });

    const results = await engine.processStaleMarketplaceListings();

    expect(results).toEqual([
      { id: "auction-1", success: true, archived: true },
      { id: "auction-2", success: true, archived: true },
    ]);
    expect(notifications.notifyContentArchived).toHaveBeenCalledTimes(2);

    // The candidate pre-select carries the same predicate the archive re-asserts,
    // plus the 30-day age cutoff on marketplace_since.
    const selectEntry = db.log.find(
      (e) => e.table === "auctions" && e.ops.some((o) => o.m === "lt"),
    );
    const eqArgs = selectEntry!.ops.filter((o) => o.m === "eq").map((o) => o.args);
    expect(eqArgs).toContainEqual(["status", "marketplace"]);
    expect(eqArgs).toContainEqual(["license_count", 0]);
    const lt = selectEntry!.ops.find((o) => o.m === "lt")!.args;
    expect(lt[0]).toBe("marketplace_since");
    expect(lt[1]).toBeTypeOf("string"); // ISO cutoff timestamp
  });

  it("returns an empty result set and archives nothing when none are stale", async () => {
    db.setResolver(() => ({ data: [], error: null }));
    const results = await engine.processStaleMarketplaceListings();
    expect(results).toEqual([]);
    expect(notifications.notifyContentArchived).not.toHaveBeenCalled();
  });
});

describe("relistListing — archived listing back to auction or marketplace (B9)", () => {
  // The relist flip is a conditional UPDATE ... .select("id"). The harness settles
  // the awaited chain via the resolver: a 1-row array = "still archived, relisted",
  // an empty array = "not archived / lost the race".
  function resolveRelist(rows: unknown[]) {
    db.setResolver(({ table, ops }: ResolveCtx) =>
      table === "auctions" && ops.some((o) => o.m === "update")
        ? { data: rows, error: null }
        : { data: null, error: null },
    );
  }

  it("auction mode: reactivates with fresh timing and a clean auction state", async () => {
    resolveRelist([{ id: "auction-1" }]);

    const r = await engine.relistListing({
      auctionId: "auction-1",
      mode: "auction",
      reservePrice: 500,
      durationHours: 4,
      fallbackPrice: 100,
    });

    expect(r).toMatchObject({ success: true, status: "active" });
    expect(r.startsAt).toBeTypeOf("string");
    expect(r.endsAt).toBeTypeOf("string");
    // ends_at is exactly duration_hours after starts_at.
    const span =
      new Date(r.endsAt!).getTime() - new Date(r.startsAt!).getTime();
    expect(span).toBe(4 * 60 * 60 * 1000);

    const update = db.updates("auctions")[0];
    expect(update).toMatchObject({
      status: "active",
      reserve_price: 500,
      duration_hours: 4,
      fallback_price: 100,
      marketplace_since: null,
      current_bid: 0,
      bid_count: 0,
      winning_bid_id: null,
      buyer_id: null,
      sale_price: null,
      auto_extended: false,
      extension_count: 0,
      rights_transferred: false,
    });
  });

  it("auction mode: defaults fallback_price to null when omitted", async () => {
    resolveRelist([{ id: "auction-1" }]);
    await engine.relistListing({
      auctionId: "auction-1",
      mode: "auction",
      reservePrice: 500,
      durationHours: 2,
    });
    expect(db.updates("auctions")[0].fallback_price).toBeNull();
  });

  it("marketplace mode: goes live at a fixed price and restarts the 30-day clock", async () => {
    resolveRelist([{ id: "auction-1" }]);

    const r = await engine.relistListing({
      auctionId: "auction-1",
      mode: "marketplace",
      fallbackPrice: 150,
    });

    expect(r).toMatchObject({ success: true, status: "marketplace" });
    const update = db.updates("auctions")[0];
    expect(update).toMatchObject({
      status: "marketplace",
      fallback_price: 150,
      rights_transferred: false,
    });
    expect(update.marketplace_since).toBeTypeOf("string");
    // Marketplace relist does not touch the auction clock.
    expect(update).not.toHaveProperty("starts_at");
    expect(update).not.toHaveProperty("ends_at");
  });

  it("gates the flip on status='archived' (the race/idempotency guard)", async () => {
    resolveRelist([{ id: "auction-1" }]);
    await engine.relistListing({
      auctionId: "auction-1",
      mode: "marketplace",
      fallbackPrice: 150,
    });
    const entry = db.log.find(
      (e) => e.table === "auctions" && e.ops.some((o) => o.m === "update"),
    );
    const eqArgs = entry!.ops.filter((o) => o.m === "eq").map((o) => o.args);
    expect(eqArgs).toContainEqual(["id", "auction-1"]);
    expect(eqArgs).toContainEqual(["status", "archived"]);
  });

  it("errors when the conditional UPDATE matches no row (not archived / lost race)", async () => {
    resolveRelist([]); // status wasn't 'archived' anymore

    const r = await engine.relistListing({
      auctionId: "auction-1",
      mode: "auction",
      reservePrice: 500,
      durationHours: 4,
    });
    expect(r.error).toBe("Listing is not archived");
    expect(r.success).toBeUndefined();
  });
});
