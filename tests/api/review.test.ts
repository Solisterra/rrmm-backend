import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeUser } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
const activateAuction = vi.fn();
const notifyContentApproved = vi.fn();
const notifyContentRejected = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/auction-engine", () => ({ activateAuction }));
vi.mock("../../lib/notifications", () => ({
  notifyContentApproved,
  notifyContentRejected,
}));

let review: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  activateAuction.mockResolvedValue({ success: true });
  review = (await import("../../pages/api/admin/review")).default;
});

const admin = () => makeUser({ id: "admin-1", role: "admin" });

// Resolver for the pending row the approve/reject branch loads.
const pendingRow =
  (over: Record<string, unknown> = {}) =>
  ({ table, terminal }: ResolveCtx) =>
    table === "auctions" && terminal === "single"
      ? {
          data: {
            photographer_id: "photographer-1",
            title: "Starship Launch",
            status: "pending",
            marketplace_since: null,
            ...over,
          },
          error: null,
        }
      : { data: null, error: null };

function runReview(
  body: unknown,
  resolver = pendingRow(),
  user: unknown = admin(),
) {
  db.getUserFromRequest.mockResolvedValue(user);
  db.setResolver(resolver);
  const req = mockReq({ method: "POST", body });
  const res = mockRes();
  return review(req, res).then(() => res);
}

describe("POST /api/admin/review — approval routing by listing kind", () => {
  it("activates an auction-path listing (no marketplace_since)", async () => {
    const res = await runReview({ auctionId: "auction-1", decision: "approved" });
    expect(res.statusCode).toBe(200);
    expect(activateAuction).toHaveBeenCalledWith("auction-1");
    expect(db.updates("auctions")).toHaveLength(0);
    expect(notifyContentApproved).toHaveBeenCalledWith(
      expect.not.objectContaining({ marketplace: true }),
    );
  });

  it("publishes a direct-to-marketplace listing instead of activating", async () => {
    const res = await runReview(
      { auctionId: "auction-1", decision: "approved" },
      pendingRow({ marketplace_since: "2026-07-06T00:00:00.000Z" }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toMatch(/marketplace/i);
    expect(activateAuction).not.toHaveBeenCalled();
    // Publishes at the fixed price and restarts the 30-day archive clock.
    expect(db.updates("auctions")).toContainEqual(
      expect.objectContaining({
        status: "marketplace",
        marketplace_since: expect.any(String),
      }),
    );
    expect(notifyContentApproved).toHaveBeenCalledWith(
      expect.objectContaining({ marketplace: true }),
    );
  });

  it("still cancels and notifies on rejection", async () => {
    const res = await runReview({ auctionId: "auction-1", decision: "rejected" });
    expect(res.statusCode).toBe(200);
    expect(db.updates("auctions")).toContainEqual(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(notifyContentRejected).toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    const res = await runReview(
      { auctionId: "auction-1", decision: "approved" },
      pendingRow(),
      makeUser({ id: "photographer-1", role: "photographer" }),
    );
    expect(res.statusCode).toBe(403);
    expect(activateAuction).not.toHaveBeenCalled();
  });
});
