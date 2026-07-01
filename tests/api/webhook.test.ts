import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";
import { makeAuction, makeTransaction } from "../helpers/factories";
import type Stripe from "stripe";
import type { DbAuction, DbTransaction } from "../../lib/types";

const db = makeSupabaseHarness();

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("../../lib/notifications", () => ({ notifyPaymentReceived: vi.fn() }));

let webhook: typeof import("../../pages/api/stripe/webhook");

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  webhook = await import("../../pages/api/stripe/webhook");
});

// Minimal PaymentIntent stand-in — only `metadata` matters for resolveTransaction.
function pi(metadata: Record<string, string>): Stripe.PaymentIntent {
  return { id: "pi_1", metadata } as unknown as Stripe.PaymentIntent;
}

describe("resolveTransaction", () => {
  it("settles by transaction_id when present", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) =>
      table === "transactions" && terminal === "single"
        ? { data: makeTransaction({ id: "tx-1" }), error: null }
        : { data: null, error: null },
    );
    const tx = await webhook.resolveTransaction(pi({ transaction_id: "tx-1" }));
    expect(tx?.id).toBe("tx-1");
  });

  it("falls back to the auction's transaction for legacy PaymentIntents", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) =>
      // legacy auction PIs use .order().limit(1).maybeSingle()
      table === "transactions" && terminal === "maybeSingle"
        ? { data: makeTransaction({ id: "tx-legacy" }), error: null }
        : { data: null, error: null },
    );
    const tx = await webhook.resolveTransaction(pi({ auction_id: "auction-1" }));
    expect(tx?.id).toBe("tx-legacy");
  });

  it("returns null when neither id is present", async () => {
    const tx = await webhook.resolveTransaction(pi({}));
    expect(tx).toBeNull();
  });
});

describe("deliverMarketplaceLicense — non-exclusive, listing stays live", () => {
  const auction = (): DbAuction =>
    makeAuction({ id: "auction-1", license_count: 4, full_url: "p/file.jpg" });
  const tx = (): DbTransaction =>
    makeTransaction({ id: "tx-1", buyer_id: "buyer-1", auction_id: "auction-1" });

  it("increments license_count", async () => {
    await webhook.deliverMarketplaceLicense(auction(), tx());
    expect(db.updates("auctions")).toContainEqual({ license_count: 5 });
  });

  it("NEVER flips the listing to a terminal state", async () => {
    await webhook.deliverMarketplaceLicense(auction(), tx());
    for (const u of db.updates("auctions")) {
      expect(u).not.toHaveProperty("status");
      expect(u).not.toHaveProperty("rights_transferred");
    }
  });

  it("notifies the specific buyer that their license is ready", async () => {
    await webhook.deliverMarketplaceLicense(auction(), tx());
    const note = db.inserts("notifications")[0];
    expect(note).toMatchObject({
      user_id: "buyer-1",
      type: "payment_received",
      auction_id: "auction-1",
    });
    expect(String(note.title)).toContain("License");
  });
});

describe("deliverExclusiveAuction — exclusive, terminal", () => {
  const auction = (over = {}): DbAuction =>
    makeAuction({ id: "auction-1", full_url: "p/file.jpg", ...over });
  const tx = (): DbTransaction =>
    makeTransaction({ id: "tx-1", buyer_id: "buyer-9", auction_id: "auction-1" });

  it("flips rights_transferred once the file is signed", async () => {
    db.setSignedUrl("https://signed.example/exclusive.jpg");
    await webhook.deliverExclusiveAuction(auction(), tx());
    expect(db.updates("auctions")).toContainEqual({ rights_transferred: true });
  });

  it("does not flip rights_transferred when there is no file", async () => {
    await webhook.deliverExclusiveAuction(auction({ full_url: null }), tx());
    expect(
      db.updates("auctions").some((u) => "rights_transferred" in u),
    ).toBe(false);
  });

  it("does not flip rights_transferred when signing fails", async () => {
    db.setSignedUrl(null);
    await webhook.deliverExclusiveAuction(auction(), tx());
    expect(
      db.updates("auctions").some((u) => "rights_transferred" in u),
    ).toBe(false);
  });

  it("does NOT touch license_count (exclusive sales are not licensed)", async () => {
    db.setSignedUrl("https://signed");
    await webhook.deliverExclusiveAuction(auction(), tx());
    for (const u of db.updates("auctions")) {
      expect(u).not.toHaveProperty("license_count");
    }
  });

  it("notifies the buyer their exclusive content is ready", async () => {
    db.setSignedUrl("https://signed");
    await webhook.deliverExclusiveAuction(auction(), tx());
    expect(db.inserts("notifications")[0]).toMatchObject({
      user_id: "buyer-9",
      type: "payment_received",
    });
  });
});
