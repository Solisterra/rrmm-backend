import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness } from "../helpers/supabase-mock";
import { makeUser } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
// placeBid (proxy bidding, increments, extensions) is unit-tested against the
// engine; here we mock it so the route's access gates are tested alone.
const placeBid = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/auction-engine", () => ({ placeBid }));

let bid: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  bid = (await import("../../pages/api/auctions/[id]/bid")).default;
});

function run(
  opts: { user?: unknown; method?: string; body?: unknown } = {},
) {
  db.getUserFromRequest.mockResolvedValue(opts.user ?? null);
  const req = mockReq({
    method: opts.method ?? "POST",
    query: { id: "auction-1" },
    body: opts.body ?? { amount: 500 },
  });
  const res = mockRes();
  return bid(req, res).then(() => res);
}

const verifiedBidder = () =>
  makeUser({ buyer_tier: "verified", bid_status: "verified" });

describe("POST /api/auctions/[id]/bid — access gates", () => {
  it("405s on a non-POST method", async () => {
    const res = await run({ method: "GET", user: verifiedBidder() });
    expect(res.statusCode).toBe(405);
  });

  it("401s when unauthenticated", async () => {
    const res = await run({ user: null });
    expect(res.statusCode).toBe(401);
    expect(placeBid).not.toHaveBeenCalled();
  });

  it("403s a marketplace-tier buyer with the explicit tier message (B6)", async () => {
    const res = await run({
      user: makeUser({ buyer_tier: "marketplace", bid_status: "none" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/Marketplace/);
    expect(placeBid).not.toHaveBeenCalled();
  });

  it("403s a marketplace-tier buyer even while bidding verification is pending", async () => {
    const res = await run({
      user: makeUser({ buyer_tier: "marketplace", bid_status: "pending" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/Marketplace/);
  });

  it("still lets a LEGACY verified bidder through (tier never backfilled)", async () => {
    placeBid.mockResolvedValue({ success: true });
    const res = await run({
      // Pre-lifecycle rows: bid_status was verified but buyer_tier kept the
      // 'marketplace' column default. The tier reject must not catch them.
      user: makeUser({ buyer_tier: "marketplace", bid_status: "verified" }),
    });
    expect(res.statusCode).toBe(200);
    expect(placeBid).toHaveBeenCalledOnce();
  });

  it("403s an unverified buyer with the generic verification message", async () => {
    const res = await run({
      user: makeUser({ buyer_tier: "verified", bid_status: "pending" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/Verified buyer/);
  });

  it("400s a verified bidder with no payment method on file", async () => {
    const res = await run({
      user: makeUser({
        buyer_tier: "verified",
        bid_status: "verified",
        stripe_customer_id: null,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(placeBid).not.toHaveBeenCalled();
  });

  it("400s when the bid amount is missing or not a number", async () => {
    const res = await run({ user: verifiedBidder(), body: { amount: "abc" } });
    expect(res.statusCode).toBe(400);
    expect(placeBid).not.toHaveBeenCalled();
  });
});

describe("POST /api/auctions/[id]/bid — happy path", () => {
  it("places the bid for a verified-tier bidder", async () => {
    placeBid.mockResolvedValue({ success: true, currentBid: 500 });
    const res = await run({
      user: makeUser({
        id: "buyer-9",
        buyer_tier: "verified",
        bid_status: "verified",
      }),
      body: { amount: 500, proxyMax: 800 },
    });
    expect(res.statusCode).toBe(200);
    expect(placeBid).toHaveBeenCalledWith({
      auctionId: "auction-1",
      bidderId: "buyer-9",
      amount: 500,
      proxyMax: 800,
    });
  });

  it("maps an engine error to a 400", async () => {
    placeBid.mockResolvedValue({ error: "Bid below minimum" });
    const res = await run({ user: verifiedBidder() });
    expect(res.statusCode).toBe(400);
  });
});
