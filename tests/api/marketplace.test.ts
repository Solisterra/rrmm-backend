import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeUser, makeAuction } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";
import { LICENSE_LEGAL_TEXT } from "../../lib/license";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
const createCheckoutSession = vi.fn();
const ensureCustomer = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/stripe", () => ({ createCheckoutSession, ensureCustomer }));

let purchase: Handler;
let detail: Handler;
let acceptLicense: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  // Default: the stored customer id is valid, so it passes through unchanged.
  ensureCustomer.mockImplementation(async (id: string | null) => ({
    id: id ?? "cus_new",
    changed: false,
  }));
  purchase = (await import("../../pages/api/marketplace/[id]/purchase")).default;
  detail = (await import("../../pages/api/marketplace/[id]")).default;
  acceptLicense = (
    await import("../../pages/api/marketplace/[id]/accept-license")
  ).default;
});

describe("POST /api/marketplace/[id]/purchase", () => {
  function run(
    opts: { user?: unknown; method?: string; body?: unknown } = {},
  ) {
    db.getUserFromRequest.mockResolvedValue(opts.user ?? null);
    const req = mockReq({
      method: opts.method ?? "POST",
      query: { id: "auction-1" },
      // Checkout includes the click-through license; tests opt out explicitly.
      body: opts.body ?? { agreement_accepted: true },
    });
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

  it("proceeds without a Connect account — platform holds funds, no destination transfer", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            id: "auction-1",
            status: "marketplace",
            fallback_price: 100,
            photographer_id: "photographer-1",
            users: {},
          }),
          error: null,
        };
      if (table === "transactions" && terminal === "single")
        return { data: { id: "tx-88" }, error: null };
      return { data: null, error: null };
    });
    createCheckoutSession.mockResolvedValue({ url: "https://checkout.example" });

    const res = await run({
      user: makeUser({ id: "buyer-1", stripe_customer_id: "cus_123" }),
    });

    // The sale is NOT blocked (mirrors the won-auction flow): the transaction is
    // created and checkout starts with no destination account, so the platform
    // collects the full amount and reconciles the payout once onboarding completes.
    expect(res.statusCode).toBe(200);
    expect(db.inserts("transactions")).toHaveLength(1);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        auctionId: "auction-1",
        transactionId: "tx-88",
        purchaseType: "marketplace",
        photographerAccountId: null,
      }),
    );
  });

  it("heals a dangling buyer customer id and persists the replacement", async () => {
    // Stored id no longer exists in the current Stripe account → ensureCustomer
    // recreates it (the "No such customer" self-heal).
    ensureCustomer.mockResolvedValueOnce({ id: "cus_fresh", changed: true });
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
        return { data: { id: "tx-91" }, error: null };
      return { data: null, error: null };
    });
    createCheckoutSession.mockResolvedValue({ url: "https://checkout.example" });

    const res = await run({
      user: makeUser({ id: "buyer-1", stripe_customer_id: "cus_stale" }),
    });

    expect(res.statusCode).toBe(200);
    // Checkout uses the healed customer, never the dangling stored id.
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ buyerStripeId: "cus_fresh" }),
    );
    // And the replacement is written back so the next purchase skips the round-trip.
    const userUpdate = db
      .updates("users")
      .find((row) => "stripe_customer_id" in row);
    expect(userUpdate).toMatchObject({ stripe_customer_id: "cus_fresh" });
  });

  it("400s (with the license terms) when the click-through is not accepted", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      body: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.body as { license?: { version: string; text: string } };
    expect(body.license?.version).toBe("v1.0");
    expect(body.license?.text).toBe(LICENSE_LEGAL_TEXT);
    expect(db.inserts("transactions")).toHaveLength(0);
  });

  it("409s when the buyer already holds a license for this content", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            status: "marketplace",
            fallback_price: 250,
            photographer_id: "photographer-1",
            users: { stripe_account_id: "acct_1" },
          }),
          error: null,
        };
      // Duplicate guard probe: buyer already has a succeeded transaction.
      if (table === "transactions" && terminal === "maybeSingle")
        return { data: { id: "tx-old" }, error: null };
      return { data: null, error: null };
    });

    const res = await run({ user: makeUser({ id: "buyer-1" }) });
    expect(res.statusCode).toBe(409);
    expect(db.inserts("transactions")).toHaveLength(0);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("records the license acceptance immutably before creating the checkout", async () => {
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
    createCheckoutSession.mockResolvedValue({ url: "https://checkout" });

    const res = await run({
      user: makeUser({ id: "buyer-1", stripe_customer_id: "cus_123" }),
    });
    expect(res.statusCode).toBe(200);

    const acceptance = db.inserts("license_acceptances")[0];
    expect(acceptance).toMatchObject({
      buyer_id: "buyer-1",
      content_id: "auction-1",
      transaction_id: "tx-77",
      agreement_accepted: true,
      license_version: "v1.0",
    });
    expect(acceptance.legal_text_snapshot).toBe(LICENSE_LEGAL_TEXT);
  });

  it("rolls back the pending transaction when the acceptance cannot be recorded", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            status: "marketplace",
            fallback_price: 250,
            photographer_id: "photographer-1",
            users: { stripe_account_id: "acct_1" },
          }),
          error: null,
        };
      if (table === "transactions" && terminal === "single")
        return { data: { id: "tx-77" }, error: null };
      if (table === "license_acceptances" && terminal === "await")
        return { data: null, error: { message: "insert blocked" } };
      return { data: null, error: null };
    });

    const res = await run({ user: makeUser({ id: "buyer-1" }) });
    expect(res.statusCode).toBe(500);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    // The orphaned pending transaction is deleted.
    const txOps = db.log
      .filter((e) => e.table === "transactions")
      .flatMap((e) => e.ops);
    expect(txOps.some((o) => o.m === "delete")).toBe(true);
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

  it("hides a no-longer-marketplace listing from viewers without a license", async () => {
    const res = await run(makeUser({ id: "buyer-1" }), ({ table, terminal }) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: { ...marketplaceListing(), status: "archived" },
          error: null,
        };
      if (table === "transactions" && terminal === "maybeSingle")
        return { data: null, error: null };
      return { data: null, error: null };
    });
    expect(res.statusCode).toBe(404);
  });

  it("keeps a paid license retrievable after the listing leaves the marketplace", async () => {
    db.setSignedUrl("https://signed.example/perpetual.jpg");
    const res = await run(makeUser({ id: "buyer-1" }), ({ table, terminal }) => {
      if (table === "auctions" && terminal === "single")
        return {
          data: { ...marketplaceListing(), status: "archived" },
          error: null,
        };
      if (table === "transactions" && terminal === "maybeSingle")
        return { data: { id: "tx-1" }, error: null }; // license already settled
      return { data: null, error: null };
    });

    expect(res.statusCode).toBe(200);
    expect((res.body as { downloadUrl: string | null }).downloadUrl).toBe(
      "https://signed.example/perpetual.jpg",
    );
    // Archived listings don't accrue marketplace view counts.
    expect(db.updates("auctions")).toHaveLength(0);
  });
});

describe("POST /api/marketplace/[id]/accept-license — B7", () => {
  // Transaction owned by buyer-1, pointing at the listing in the path.
  const ownedTx = { id: "tx-77", buyer_id: "buyer-1", auction_id: "auction-1" };
  const marketplaceListing = { id: "auction-1", status: "marketplace" };

  // Resolver for the happy path: tx → listing → no existing acceptance → insert.
  const happyResolver = ({ table, terminal }: ResolveCtx) => {
    if (table === "transactions") return { data: ownedTx, error: null };
    if (table === "auctions") return { data: marketplaceListing, error: null };
    if (table === "license_acceptances" && terminal === "maybeSingle")
      return { data: null, error: null };
    if (table === "license_acceptances" && terminal === "single")
      return {
        data: {
          id: "la-1",
          accepted_at: "2026-07-01T00:00:00.000Z",
          license_version: "v1.0",
        },
        error: null,
      };
    return { data: null, error: null };
  };

  function run(
    opts: {
      user?: unknown;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      resolver?: (ctx: ResolveCtx) => { data: unknown; error: unknown };
    } = {},
  ) {
    db.getUserFromRequest.mockResolvedValue(opts.user ?? null);
    if (opts.resolver) db.setResolver(opts.resolver);
    const req = mockReq({
      method: opts.method ?? "POST",
      query: { id: "auction-1" },
      body: opts.body ?? { transaction_id: "tx-77", agreement_accepted: true },
      headers: opts.headers,
    });
    const res = mockRes();
    return acceptLicense(req, res).then(() => res);
  }

  it("405s on a non-POST method", async () => {
    const res = await run({ method: "GET", user: makeUser({ id: "buyer-1" }) });
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

  it("400s when transaction_id is missing", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      body: { agreement_accepted: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when the license terms are not accepted", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      body: { transaction_id: "tx-77", agreement_accepted: false },
    });
    expect(res.statusCode).toBe(400);
    // Nothing is written when acceptance is not affirmed.
    expect(db.inserts("license_acceptances")).toHaveLength(0);
  });

  it("404s when the transaction does not exist", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: ({ table }) =>
        table === "transactions"
          ? { data: null, error: null }
          : { data: null, error: null },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s when the transaction belongs to another buyer", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: ({ table }) =>
        table === "transactions"
          ? { data: { ...ownedTx, buyer_id: "someone-else" }, error: null }
          : { data: null, error: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s when the transaction does not match the listing in the path", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: ({ table }) =>
        table === "transactions"
          ? { data: { ...ownedTx, auction_id: "other-auction" }, error: null }
          : { data: null, error: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when the listing is not a marketplace item", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: ({ table }) => {
        if (table === "transactions") return { data: ownedTx, error: null };
        if (table === "auctions")
          return { data: { id: "auction-1", status: "sold" }, error: null };
        return { data: null, error: null };
      },
    });
    expect(res.statusCode).toBe(400);
    expect(db.inserts("license_acceptances")).toHaveLength(0);
  });

  it("records an immutable acceptance with the frozen terms + audit fingerprint", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: happyResolver,
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "Mozilla/Test",
        "x-session-id": "sess-xyz",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      acceptance: {
        id: "la-1",
        accepted_at: "2026-07-01T00:00:00.000Z",
        version: "v1.0",
      },
    });

    const row = db.inserts("license_acceptances")[0];
    expect(row).toMatchObject({
      buyer_id: "buyer-1",
      content_id: "auction-1",
      transaction_id: "tx-77",
      agreement_accepted: true,
      ip_address: "203.0.113.7",
      user_agent: "Mozilla/Test",
      session_id: "sess-xyz",
      license_version: "v1.0",
    });
    // The exact terms shown are frozen into the row — byte-identical to the
    // canonical text (which must itself match the copy the frontend renders).
    expect(row.legal_text_snapshot).toBe(LICENSE_LEGAL_TEXT);
  });

  it("is idempotent: a repeat accept returns the first record and writes nothing", async () => {
    const res = await run({
      user: makeUser({ id: "buyer-1" }),
      resolver: ({ table, terminal }) => {
        if (table === "transactions") return { data: ownedTx, error: null };
        if (table === "auctions")
          return { data: marketplaceListing, error: null };
        if (table === "license_acceptances" && terminal === "maybeSingle")
          return {
            data: {
              id: "la-existing",
              accepted_at: "2026-06-30T00:00:00.000Z",
              license_version: "v1.0",
            },
            error: null,
          };
        return { data: null, error: null };
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.body as { acceptance: { id: string } }).acceptance.id).toBe(
      "la-existing",
    );
    expect(db.inserts("license_acceptances")).toHaveLength(0);
  });
});
