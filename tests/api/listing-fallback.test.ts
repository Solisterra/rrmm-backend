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

let create: Handler;
let update: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  create = (await import("../../pages/api/auctions/index")).default;
  update = (await import("../../pages/api/auctions/[id]")).default;
});

// ── POST /api/auctions — fallback price set at creation (spec §1) ─────────────

const photographer = () =>
  makeUser({ id: "photographer-1", role: "photographer", sell_status: "verified" });

const validBody = (over: Record<string, unknown> = {}) => ({
  title: "Starship Launch",
  category: "Launch Event",
  content_type: "photo",
  exclusivity: "Full Exclusive",
  preview_url: "https://preview",
  reserve_price: 1000,
  duration_hours: 4,
  attestation: {
    confirmed_ownership: true,
    confirmed_unpublished: true,
    confirmed_no_third_party: true,
    confirmed_consequences: true,
  },
  ...over,
});

function createResolver({ table, ops, terminal }: ResolveCtx) {
  if (table === "auctions" && terminal === "single") {
    // Insert echo (creation) — updates settle via the thenable path.
    if (ops.some((o) => o.m === "insert"))
      return { data: makeAuction({ id: "auction-9" }), error: null };
  }
  if (table === "attestations" && terminal === "single")
    return {
      data: {
        id: "att-1",
        attested_at: "2026-07-01T00:00:00.000Z",
        attestation_version: "v1.0",
      },
      error: null,
    };
  return { data: null, error: null };
}

function runCreate(body: unknown, user: unknown = photographer()) {
  db.getUserFromRequest.mockResolvedValue(user);
  db.setResolver(createResolver);
  const req = mockReq({ method: "POST", body });
  const res = mockRes();
  return create(req, res).then(() => res);
}

describe("POST /api/auctions — marketplace fallback price", () => {
  it("persists an optional fallback price with the listing", async () => {
    const res = await runCreate(validBody({ fallback_price: 300 }));
    expect(res.statusCode).toBe(201);
    expect(db.inserts("auctions")[0]).toMatchObject({
      reserve_price: 1000,
      fallback_price: 300,
    });
  });

  it("stores null when the fallback is left blank (reverts-to-photographer path)", async () => {
    const res = await runCreate(validBody());
    expect(res.statusCode).toBe(201);
    expect(db.inserts("auctions")[0]).toMatchObject({ fallback_price: null });
  });

  it("treats an empty-string fallback as blank", async () => {
    const res = await runCreate(validBody({ fallback_price: "" }));
    expect(res.statusCode).toBe(201);
    expect(db.inserts("auctions")[0]).toMatchObject({ fallback_price: null });
  });

  it("rejects a non-positive fallback price", async () => {
    const res = await runCreate(validBody({ fallback_price: -5 }));
    expect(res.statusCode).toBe(400);
    expect(db.inserts("auctions")).toHaveLength(0);
  });

  it("rejects a non-numeric fallback price", async () => {
    const res = await runCreate(validBody({ fallback_price: "cheap" }));
    expect(res.statusCode).toBe(400);
    expect(db.inserts("auctions")).toHaveLength(0);
  });
});

// ── PATCH /api/auctions/[id] — add/change/clear the fallback pre-launch ───────

function runPatch(body: unknown, auctionOver: Record<string, unknown> = {}) {
  db.getUserFromRequest.mockResolvedValue(photographer());
  db.setResolver(({ table, terminal }: ResolveCtx) =>
    table === "auctions" && terminal === "single"
      ? {
          data: makeAuction({
            id: "auction-9",
            photographer_id: "photographer-1",
            status: "pending",
            ...auctionOver,
          }),
          error: null,
        }
      : { data: null, error: null },
  );
  const req = mockReq({ method: "PATCH", query: { id: "auction-9" }, body });
  const res = mockRes();
  return update(req, res).then(() => res);
}

describe("PATCH /api/auctions/[id] — marketplace fallback price", () => {
  it("lets the owner add a fallback to a pending listing", async () => {
    const res = await runPatch({ fallback_price: 120 });
    expect(res.statusCode).toBe(200);
    expect(db.updates("auctions")).toContainEqual(
      expect.objectContaining({ fallback_price: 120 }),
    );
  });

  it("lets the owner clear the fallback with null", async () => {
    const res = await runPatch({ fallback_price: null });
    expect(res.statusCode).toBe(200);
    expect(db.updates("auctions")).toContainEqual(
      expect.objectContaining({ fallback_price: null }),
    );
  });

  it("rejects a non-positive fallback price", async () => {
    const res = await runPatch({ fallback_price: 0 });
    expect(res.statusCode).toBe(400);
    expect(db.updates("auctions")).toHaveLength(0);
  });
});

// ── POST /api/auctions — direct-to-marketplace listings (listing_type) ────────

const marketplaceBody = (over: Record<string, unknown> = {}) => ({
  title: "Starship Launch",
  category: "Launch Event",
  content_type: "photo",
  preview_url: "https://preview",
  listing_type: "marketplace",
  fallback_price: 55,
  attestation: {
    confirmed_ownership: true,
    confirmed_unpublished: true,
    confirmed_no_third_party: true,
    confirmed_consequences: true,
  },
  ...over,
});

describe("POST /api/auctions — listing_type='marketplace'", () => {
  it("creates a pending marketplace listing without auction fields", async () => {
    const res = await runCreate(marketplaceBody());
    expect(res.statusCode).toBe(201);
    const insert = db.inserts("auctions")[0];
    expect(insert).toMatchObject({
      status: "pending",
      fallback_price: 55,
      // reserve_price (NOT NULL column) mirrors the price; never gates a bid.
      reserve_price: 55,
      exclusivity: "Non-Exclusive",
    });
    // The pending-marketplace marker admin review branches on.
    expect(insert.marketplace_since).toEqual(expect.any(String));
    // No auction window: duration keeps its column default.
    expect(insert).not.toHaveProperty("duration_hours");
  });

  it("forces Non-Exclusive even if another exclusivity is sent", async () => {
    const res = await runCreate(
      marketplaceBody({ exclusivity: "Full Exclusive" }),
    );
    expect(res.statusCode).toBe(201);
    expect(db.inserts("auctions")[0]).toMatchObject({
      exclusivity: "Non-Exclusive",
    });
  });

  it("rejects a marketplace listing without a price", async () => {
    const res = await runCreate(marketplaceBody({ fallback_price: undefined }));
    expect(res.statusCode).toBe(400);
    expect(db.inserts("auctions")).toHaveLength(0);
  });

  it("rejects an unknown listing_type", async () => {
    const res = await runCreate(validBody({ listing_type: "raffle" }));
    expect(res.statusCode).toBe(400);
    expect(db.inserts("auctions")).toHaveLength(0);
  });

  it("still requires reserve + duration on the default auction path", async () => {
    const res = await runCreate(
      validBody({ reserve_price: undefined, listing_type: "auction" }),
    );
    expect(res.statusCode).toBe(400);
    expect(db.inserts("auctions")).toHaveLength(0);
  });
});
