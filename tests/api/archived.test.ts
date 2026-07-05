import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeUser, makeAuction } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));

let archived: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  archived = (await import("../../pages/api/users/archived")).default;
});

function run(
  opts: {
    user?: unknown;
    method?: string;
    resolver?: (ctx: ResolveCtx) => { data: unknown; error: unknown };
  } = {},
) {
  db.getUserFromRequest.mockResolvedValue(opts.user ?? null);
  if (opts.resolver) db.setResolver(opts.resolver);
  const req = mockReq({ method: opts.method ?? "GET" });
  const res = mockRes();
  return archived(req, res).then(() => res);
}

const seller = () =>
  makeUser({
    id: "photographer-1",
    role: "photographer",
    sell_status: "verified",
  });

describe("GET /api/users/archived — gates", () => {
  it("405s on a non-GET method", async () => {
    const res = await run({ method: "POST", user: seller() });
    expect(res.statusCode).toBe(405);
  });

  it("401s when unauthenticated", async () => {
    const res = await run({ user: null });
    expect(res.statusCode).toBe(401);
  });

  it("403s a caller without seller verification", async () => {
    const res = await run({
      user: makeUser({ role: "buyer", sell_status: "none" }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/users/archived — listing", () => {
  it("returns the caller's archived listings shaped for the dashboard", async () => {
    const row = makeAuction({
      id: "auction-7",
      photographer_id: "photographer-1",
      status: "archived",
      fallback_price: 40,
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    const res = await run({
      user: seller(),
      resolver: ({ table, terminal }) =>
        table === "auctions" && terminal === "await"
          ? { data: [row], error: null }
          : { data: null, error: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { archived: Array<Record<string, unknown>> };
    expect(body.archived).toHaveLength(1);
    expect(body.archived[0]).toMatchObject({
      id: "auction-7",
      photographer_id: "photographer-1",
      title: row.title,
      price: 40,
      archivedAt: "2026-06-01T00:00:00.000Z",
    });
    // Relist candidates carry no live-auction or buyer fields.
    expect(body.archived[0]).not.toHaveProperty("currentBid");
    expect(body.archived[0]).not.toHaveProperty("full_url");
  });

  it("scopes the query to the caller and archived status", async () => {
    await run({ user: seller() });
    const auctionOps = db.log.find((e) => e.table === "auctions")!.ops;
    const eqs = auctionOps.filter((o) => o.m === "eq").map((o) => o.args);
    expect(eqs).toContainEqual(["photographer_id", "photographer-1"]);
    expect(eqs).toContainEqual(["status", "archived"]);
  });

  it("returns an empty archive when nothing has been archived", async () => {
    const res = await run({
      user: seller(),
      resolver: () => ({ data: null, error: null }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ archived: [] });
  });
});
