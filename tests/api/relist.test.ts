import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeUser } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
// relistListing (the state transition) is unit-tested against the engine; here we
// mock it so the route's auth/ownership/validation + error mapping is tested alone.
const relistListing = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/auction-engine", () => ({ relistListing }));

let relist: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  relist = (await import("../../pages/api/auctions/[id]/relist")).default;
});

// Default: an archived listing owned by 'photographer-1'.
const archivedOwned = ({ table, terminal }: ResolveCtx) =>
  table === "auctions" && terminal === "single"
    ? {
        data: {
          id: "auction-1",
          photographer_id: "photographer-1",
          status: "archived",
        },
        error: null,
      }
    : { data: null, error: null };

function run(
  opts: {
    user?: unknown;
    method?: string;
    body?: unknown;
    resolver?: (ctx: ResolveCtx) => { data: unknown; error: unknown };
  } = {},
) {
  db.getUserFromRequest.mockResolvedValue(opts.user ?? null);
  db.setResolver(opts.resolver ?? archivedOwned);
  const req = mockReq({
    method: opts.method ?? "POST",
    query: { id: "auction-1" },
    body: opts.body ?? {},
  });
  const res = mockRes();
  return relist(req, res).then(() => res);
}

const owner = () => makeUser({ id: "photographer-1", role: "photographer" });

describe("POST /api/auctions/[id]/relist — gates", () => {
  it("405s on a non-POST method", async () => {
    const res = await run({ method: "GET", user: owner() });
    expect(res.statusCode).toBe(405);
  });

  it("401s when unauthenticated", async () => {
    const res = await run({ user: null });
    expect(res.statusCode).toBe(401);
  });

  it("404s when the listing does not exist", async () => {
    const res = await run({
      user: owner(),
      resolver: () => ({ data: null, error: null }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s when the caller does not own the listing", async () => {
    const res = await run({
      user: makeUser({ id: "someone-else", role: "photographer" }),
      body: { mode: "marketplace", fallback_price: 100 },
    });
    expect(res.statusCode).toBe(403);
    expect(relistListing).not.toHaveBeenCalled();
  });

  it("400s when the listing is not archived", async () => {
    const res = await run({
      user: owner(),
      body: { mode: "marketplace", fallback_price: 100 },
      resolver: ({ table, terminal }) =>
        table === "auctions" && terminal === "single"
          ? {
              data: {
                id: "auction-1",
                photographer_id: "photographer-1",
                status: "marketplace",
              },
              error: null,
            }
          : { data: null, error: null },
    });
    expect(res.statusCode).toBe(400);
    expect(relistListing).not.toHaveBeenCalled();
  });

  it("400s on an unknown mode", async () => {
    const res = await run({ user: owner(), body: { mode: "giveaway" } });
    expect(res.statusCode).toBe(400);
    expect(relistListing).not.toHaveBeenCalled();
  });
});

describe("POST /api/auctions/[id]/relist — auction mode", () => {
  it("400s when the reserve price is below the $25 minimum", async () => {
    const res = await run({
      user: owner(),
      body: { mode: "auction", reserve_price: 10, duration_hours: 4 },
    });
    expect(res.statusCode).toBe(400);
    expect(relistListing).not.toHaveBeenCalled();
  });

  it("400s on an invalid auction duration", async () => {
    const res = await run({
      user: owner(),
      body: { mode: "auction", reserve_price: 500, duration_hours: 3 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when an explicit fallback price is not positive", async () => {
    const res = await run({
      user: owner(),
      body: {
        mode: "auction",
        reserve_price: 500,
        duration_hours: 4,
        fallback_price: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("relists as an auction on the happy path", async () => {
    relistListing.mockResolvedValue({
      success: true,
      status: "active",
      startsAt: "S",
      endsAt: "E",
    });
    const res = await run({
      user: owner(),
      body: {
        mode: "auction",
        reserve_price: 500,
        duration_hours: 4,
        fallback_price: 120,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(relistListing).toHaveBeenCalledWith({
      auctionId: "auction-1",
      mode: "auction",
      reservePrice: 500,
      durationHours: 4,
      fallbackPrice: 120,
    });
  });

  it("passes fallbackPrice=null when it is omitted", async () => {
    relistListing.mockResolvedValue({ success: true, status: "active" });
    await run({
      user: owner(),
      body: { mode: "auction", reserve_price: 500, duration_hours: 2 },
    });
    expect(relistListing).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackPrice: null }),
    );
  });
});

describe("POST /api/auctions/[id]/relist — marketplace mode", () => {
  it("400s when no marketplace price is supplied", async () => {
    const res = await run({ user: owner(), body: { mode: "marketplace" } });
    expect(res.statusCode).toBe(400);
    expect(relistListing).not.toHaveBeenCalled();
  });

  it("relists straight to the marketplace on the happy path", async () => {
    relistListing.mockResolvedValue({ success: true, status: "marketplace" });
    const res = await run({
      user: owner(),
      body: { mode: "marketplace", fallback_price: 150 },
    });
    expect(res.statusCode).toBe(200);
    expect(relistListing).toHaveBeenCalledWith({
      auctionId: "auction-1",
      mode: "marketplace",
      fallbackPrice: 150,
    });
  });
});

describe("POST /api/auctions/[id]/relist — admin + race mapping", () => {
  it("lets an admin relist a listing they do not own", async () => {
    relistListing.mockResolvedValue({ success: true, status: "marketplace" });
    const res = await run({
      user: makeUser({ id: "admin-1", role: "admin" }),
      body: { mode: "marketplace", fallback_price: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(relistListing).toHaveBeenCalledOnce();
  });

  it("409s when the engine's archived-only guard loses a race", async () => {
    relistListing.mockResolvedValue({ error: "Listing is not archived" });
    const res = await run({
      user: owner(),
      body: { mode: "marketplace", fallback_price: 100 },
    });
    expect(res.statusCode).toBe(409);
  });
});
