import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { makeSupabaseHarness } from "../helpers/supabase-mock";
import { makeUser } from "../helpers/factories";
import { mockReq, mockRes } from "../helpers/http";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const db = makeSupabaseHarness();
const getOrCreateCustomer = vi.fn();
const createConnectAccount = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/stripe", () => ({
  getOrCreateCustomer,
  createConnectAccount,
}));

let register: Handler;

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  getOrCreateCustomer.mockResolvedValue({ id: "cus_new" });
  createConnectAccount.mockResolvedValue({ id: "acct_new" });
  db.setResolver(({ table, ops, terminal }) =>
    table === "users" && terminal === "single"
      ? // Handle-uniqueness probe returns no row; the insert echoes a user.
        ops.some((o) => o.m === "insert")
        ? { data: makeUser({ id: "user-new" }), error: null }
        : { data: null, error: null }
      : { data: null, error: null },
  );
  register = (await import("../../pages/api/users/register")).default;
});

function run(body: unknown) {
  const req = mockReq({ method: "POST", body });
  const res = mockRes();
  return register(req, res).then(() => res);
}

describe("POST /api/users/register — self-service buyer tier (B10)", () => {
  it("registers a buyer with no followers at all (old 50k gate removed)", async () => {
    const res = await run({
      authId: "auth-9",
      email: "new@example.com",
      role: "buyer",
    });
    expect(res.statusCode).toBe(201);
    // Stripe customer is still created up front — the payment-method anchor.
    expect(getOrCreateCustomer).toHaveBeenCalledOnce();
    // No buyer_tier is sent: the DB default 'marketplace' is the tier.
    const inserts = db.inserts("users");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ role: "buyer", follower_count: 0 });
    expect("buyer_tier" in inserts[0]).toBe(false);
  });

  it("still requires authId, email and role", async () => {
    const res = await run({ role: "buyer" });
    expect(res.statusCode).toBe(400);
    expect(db.inserts("users")).toHaveLength(0);
  });

  it("still rejects unknown roles", async () => {
    const res = await run({
      authId: "auth-9",
      email: "new@example.com",
      role: "admin",
    });
    expect(res.statusCode).toBe(400);
  });
});
