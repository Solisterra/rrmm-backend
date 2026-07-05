import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness } from "../helpers/supabase-mock";
import { makeUser } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();

vi.mock("../../lib/supabase", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/supabase")>(
      "../../lib/supabase",
    );
  return {
    supabaseAdmin: db.supabaseAdmin,
    getUserFromRequest: db.getUserFromRequest,
    supabaseQuery: db.supabaseQuery,
    supabase: db.supabase,
    formatUser: actual.formatUser,
  };
});

let capabilities: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  capabilities = (await import("../../pages/api/admin/capabilities")).default;
});

function review(body: unknown, user: unknown = makeUser({ role: "admin" })) {
  db.getUserFromRequest.mockResolvedValue(user);
  // Every terminal resolves to a user row so `.select().single()` after the
  // update has something to format.
  db.setResolver(({ table }) =>
    table === "users"
      ? { data: makeUser({ id: "buyer-1" }), error: null }
      : { data: null, error: null },
  );
  const req = mockReq({ method: "POST", body });
  const res = mockRes();
  return capabilities(req, res).then(() => res);
}

describe("POST /api/admin/capabilities — buyer_tier sync (B6)", () => {
  it("403s a non-admin caller", async () => {
    const res = await review(
      { userId: "buyer-1", capability: "buyer", decision: "approved" },
      makeUser({ role: "buyer" }),
    );
    expect(res.statusCode).toBe(403);
  });

  it("approving bidding promotes the buyer out of the marketplace tier", async () => {
    const res = await review({
      userId: "buyer-1",
      capability: "buyer",
      decision: "approved",
    });
    expect(res.statusCode).toBe(200);
    const updates = db.updates("users");
    expect(updates).toContainEqual({ bid_status: "verified" });
    expect(updates).toContainEqual({ buyer_tier: "verified" });
  });

  it("rejecting bidding leaves the tier untouched", async () => {
    const res = await review({
      userId: "buyer-1",
      capability: "buyer",
      decision: "rejected",
    });
    expect(res.statusCode).toBe(200);
    const updates = db.updates("users");
    expect(updates).toContainEqual({ bid_status: "rejected" });
    expect(updates.some((u) => "buyer_tier" in u)).toBe(false);
  });

  it("approving SELLING never touches the buyer tier", async () => {
    const res = await review({
      userId: "photographer-1",
      capability: "seller",
      decision: "approved",
    });
    expect(res.statusCode).toBe(200);
    const updates = db.updates("users");
    expect(updates).toContainEqual({ sell_status: "verified" });
    expect(updates.some((u) => "buyer_tier" in u)).toBe(false);
  });
});
