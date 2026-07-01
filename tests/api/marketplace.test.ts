import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeUser, makeAuction } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
const createCheckoutSession = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/stripe", () => ({ createCheckoutSession }));

let purchase: Handler;
let detail: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  purchase = (await import("../../pages/api/marketplace/[id]/purchase")).default;
  detail = (await import("../../pages/api/marketplace/[id]")).default;
});

describe("POST /api/marketplace/[id]/purchase", () => {
  function run(body: { user?: unknown; method?: string } = {}) {
    db.getUserFromRequest.mockResolvedValue(body.user ?? null);
    const req = mockReq({ method: body.method ?? "POST", query: { id: "auction-1" } });
    const res = mockRes();
    return purchase(req, res).then(() => res);
  }

  it("405s on a non-POST method", async () => {
    const res = await run({ method: "GET", user: makeUser() });
    expect(res.statusCode).toBe(405);
  });

  it("401s when unauthenticated", async () => {
    const res = await run({ user: null });
    expect(res.statusCode).toBe(401);
  });

  it("403s when the caller is not a buyer", async () => {
    const res = await run({ user: makeUser({ role: "photographer" }) });
    expect(res.statusCode).toBe(403);
  });

  it("400s when the buyer has no payment method", async () => {
    const res = await run({ user: makeUser({ stripe_customer_id: null }) });
    expect(res.statusCode).toBe(400);
  });

  it("404s when the listing does not exist", async () => {
    db.setResolver(() => ({ data: null, error: null }));
    const res = await run({ user: makeUser({ id: "buyer-1" }) });
    expect(res.statusCode).toBe(404);
  });

  it("400s when the listing is not a buyable marketplace item", async () => {
    db.setResolver(() => ({
      data: makeAuction({ status: "active", fallback_price: null }),
      error: null,
    }));
    const res = await run({ user: makeUser({ id: "buyer-1" }) });
    expect(res.statusCode).toBe(400);
  });

  it("403s when the buyer owns the content", async () => {
    db.setResolver(() => ({
      data: makeAuction({
        status: "marketplace",
        fallback_price: 250,
        photographer_id: "buyer-1",
      }),
      error: null,
    }));
    const res = await run({ user: makeUser({ id: "buyer-1" }) });
    expect(res.statusCode).toBe(403);
  });

  it("creates a pending transaction + marketplace checkout on the happy path", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            id: "auction-1",
            status: "marketplace",
            fallback_price: 250,
            photographer_id: "photographer-1",
            users: { stripe_account_id: "acct_1" },
          }),
          error: null,
        };
      if (table === "transactions" && terminal === "single")
        return { data: { id: "tx-77" }, error: null };
      return { data: null, error: null };
    });
    createCheckoutSession.mockResolvedValue({ url: "https://checkout.example" });

    const res = await run({
      user: makeUser({ id: "buyer-1", stripe_customer_id: "cus_123" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      url: "https://checkout.example",
      transactionId: "tx-77",
    });

    // One pending transaction with the shared 80/20 split.
    const tx = db.inserts("transactions")[0];
    expect(tx).toMatchObject({
      auction_id: "auction-1",
      buyer_id: "buyer-1",
      photographer_id: "photographer-1",
      gross_amount: 250,
      platform_fee: 50,
      photographer_payout: 200,
    });

    // Checkout carries the transaction id + marketplace tag for the webhook.
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 250,
        auctionId: "auction-1",
        transactionId: "tx-77",
        purchaseType: "marketplace",
        buyerStripeId: "cus_123",
        photographerAccountId: "acct_1",
      }),
    );
  });

  it("propagates a destination charge of null when the photographer has no Connect account", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            status: "marketplace",
            fallback_price: 100,
            photographer_id: "photographer-1",
            users: {},
          }),
          error: null,
        };
      if (table === "transactions" && terminal === "single")
        return { data: { id: "tx-1" }, error: null };
      return { data: null, error: null };
    });
    createCheckoutSession.mockResolvedValue({ url: "https://checkout" });

    await run({ user: makeUser({ id: "buyer-1" }) });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ photographerAccountId: null }),
    );
  });
});

describe("GET /api/marketplace/[id] — per-buyer delivery", () => {
  function run(user: unknown, resolver: (ctx: ResolveCtx) => { data: unknown; error: unknown }) {
    db.getUserFromRequest.mockResolvedValue(user);
    db.setResolver(resolver);
    const req = mockReq({ method: "GET", query: { id: "auction-1" } });
    const res = mockRes();
    return detail(req, res).then(() => res);
  }

  const marketplaceListing = () =>
    makeAuction({
      id: "auction-1",
      status: "marketplace",
      fallback_price: 250,
      full_url: "photographer-1/file.jpg",
      users: { id: "photographer-1", handle: "cam" },
    });

  it("404s when the listing is not a marketplace item", async () => {
    const res = await run(null, () => ({ data: null, error: { message: "no" } }));
    expect(res.statusCode).toBe(404);
  });

  it("returns the item with no download URL for anonymous viewers", async () => {
    const res = await run(null, ({ table, terminal }) =>
      table === "auctions" && terminal === "single"
        ? { data: marketplaceListing(), error: null }
        : { data: null, error: null },
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { item: unknown; downloadUrl: string | null };
    expect(body.item).toBeTruthy();
    expect(body.downloadUrl).toBeNull();
  });

  it("hands a buyer with a settled transaction a signed download URL", async () => {
    db.setSignedUrl("https://signed.example/buyer-copy.jpg");
    const res = await run(makeUser({ id: "buyer-1" }), ({ table, terminal }) => {
      if (table === "auctions" && terminal === "single")
        return { data: marketplaceListing(), error: null };
      if (table === "transactions" && terminal === "maybeSingle")
        return { data: { id: "tx-1" }, error: null }; // buyer has paid
      return { data: null, error: null };
    });

    const body = res.body as { downloadUrl: string | null };
    expect(body.downloadUrl).toBe("https://signed.example/buyer-copy.jpg");
  });

  it("withholds the download from a buyer who has not paid", async () => {
    const res = await run(makeUser({ id: "buyer-1" }), ({ table, terminal }) => {
      if (table === "auctions" && terminal === "single")
        return { data: marketplaceListing(), error: null };
      if (table === "transactions" && terminal === "maybeSingle")
        return { data: null, error: null }; // no settled tx
      return { data: null, error: null };
    });
    const body = res.body as { downloadUrl: string | null };
    expect(body.downloadUrl).toBeNull();
  });
});
