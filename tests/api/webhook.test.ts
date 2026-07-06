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

describe("handlePaymentSucceeded — idempotent settlement", () => {
  it("short-circuits when the transaction is already settled (Stripe redelivery)", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) =>
      table === "transactions" && terminal === "single"
        ? {
            data: makeTransaction({
              id: "tx-1",
              payment_status: "succeeded",
            }),
            error: null,
          }
        : { data: null, error: null },
    );

    await webhook.handlePaymentSucceeded(
      pi({ transaction_id: "tx-1", purchase_type: "marketplace" }),
    );

    // Nothing is re-written: no second license_count bump, no re-notification.
    expect(db.updates("transactions")).toHaveLength(0);
    expect(db.updates("auctions")).toHaveLength(0);
    expect(db.inserts("notifications")).toHaveLength(0);
  });

  it("settles a pending marketplace transaction exactly once", async () => {
    db.setResolver(({ table, terminal }: ResolveCtx) => {
      if (table === "transactions" && terminal === "single")
        return {
          data: makeTransaction({
            id: "tx-1",
            auction_id: "auction-1",
            buyer_id: "buyer-1",
            photographer_id: "photographer-1",
            payment_status: "pending",
            photographer_payout: 200,
          }),
          error: null,
        };
      if (table === "auctions" && terminal === "single")
        return {
          data: makeAuction({
            id: "auction-1",
            status: "marketplace",
            license_count: 0,
            full_url: "p/file.jpg",
          }),
          error: null,
        };
      if (table === "users" && terminal === "single")
        return {
          data: { id: "photographer-1", stripe_account_id: "acct_1" },
          error: null,
        };
      return { data: null, error: null };
    });

    await webhook.handlePaymentSucceeded(
      pi({ transaction_id: "tx-1", purchase_type: "marketplace" }),
    );

    expect(db.updates("transactions")).toContainEqual(
      expect.objectContaining({
        payment_status: "succeeded",
        payment_intent_id: "pi_1",
      }),
    );
    expect(db.updates("auctions")).toContainEqual({ license_count: 1 });
    expect(db.updates("transactions")).toContainEqual(
      expect.objectContaining({ payout_status: "in_transit" }),
    );
  });
});

describe("handleTransferCreated — payout reconciliation by charge", () => {
  it("marks the payout settled on the transaction matching the source charge", async () => {
    await webhook.handleTransferCreated({
      id: "tr_9",
      source_transaction: "ch_42",
    } as unknown as Stripe.Transfer);

    expect(db.updates("transactions")).toContainEqual(
      expect.objectContaining({ payout_id: "tr_9", payout_status: "paid" }),
    );
    // Joined on the charge id we stored at settlement — not on a payout_id
    // nothing ever wrote.
    const ops = db.log
      .filter((e) => e.table === "transactions")
      .flatMap((e) => e.ops);
    expect(ops).toContainEqual({ m: "eq", args: ["charge_id", "ch_42"] });
  });

  it("does nothing when the transfer has no source charge", async () => {
    await webhook.handleTransferCreated({
      id: "tr_9",
      source_transaction: null,
    } as unknown as Stripe.Transfer);
    expect(db.updates("transactions")).toHaveLength(0);
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

  it("restores a listing archived mid-checkout (it now has a paid license)", async () => {
    await webhook.deliverMarketplaceLicense(
      makeAuction({ id: "auction-1", status: "archived", license_count: 0 }),
      tx(),
    );
    expect(db.updates("auctions")).toContainEqual({ status: "marketplace" });
    // Conditional flip: only from 'archived' — a listing already relisted as a
    // live auction must be left untouched.
    const ops = db.log
      .filter((e) => e.table === "auctions")
      .flatMap((e) => e.ops);
    expect(ops).toContainEqual({ m: "eq", args: ["status", "archived"] });
  });

  it("leaves a relisted (non-archived) listing's status untouched", async () => {
    await webhook.deliverMarketplaceLicense(
      makeAuction({ id: "auction-1", status: "active", license_count: 0 }),
      tx(),
    );
    for (const u of db.updates("auctions")) {
      expect(u).not.toHaveProperty("status");
    }
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
