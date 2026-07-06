import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { buffer } from "micro";
import Stripe from "stripe";
import { supabaseAdmin } from "../../../lib/supabase";
import { storage } from "../../../lib/storage";
import { notifyPaymentReceived } from "../../../lib/notifications";
import type { DbAuction, DbUser, DbTransaction } from "../../../lib/types";

export const config = { api: { bodyParser: false } };

let _stripe: Stripe | null = null;
const getStripe = () =>
  (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY!, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiVersion: "2026-04-22.dahlia" as any,
  }));

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"] as string;

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("Webhook signature failed:", (err as Error).message);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case "transfer.created":
        await handleTransferCreated(event.data.object as Stripe.Transfer);
        break;
      case "payout.paid":
        await handlePayoutPaid(event.data.object as Stripe.Payout);
        break;
      case "account.updated":
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }

  return res.status(200).json({ received: true });
}

// Exported for unit testing (not a route export — Next only treats `default`/`config` specially).
export async function handlePaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
) {
  const tx = await resolveTransaction(paymentIntent);
  if (!tx) {
    console.error(
      `payment_intent.succeeded ${paymentIntent.id}: no transaction resolved`,
    );
    return;
  }

  // Stripe retries deliveries on any non-2xx, so this handler must be
  // idempotent. Settlement is the one-way latch: once this transaction is
  // 'succeeded', a redelivery must not bump license_count again or re-send
  // buyer/photographer notifications.
  if (tx.payment_status === "succeeded") return;

  // Settle THIS transaction by its id — never by auction_id. A marketplace listing
  // has many transactions (one per non-exclusive license); keying off auction_id
  // would corrupt every other buyer's row. Hosted Checkout creates the
  // PaymentIntent at pay time, so the row has no payment_intent_id until now.
  await supabaseAdmin
    .from("transactions")
    .update({
      payment_status: "succeeded",
      payment_intent_id: paymentIntent.id,
      charge_id: paymentIntent.latest_charge,
    })
    .eq("id", tx.id);

  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", tx.auction_id)
    .single();
  if (!auction) {
    console.error(
      `Transaction ${tx.id} references missing auction ${tx.auction_id}`,
    );
    return;
  }
  const a = auction as DbAuction;

  // Delivery differs by tier: exclusive auctions terminate the listing; marketplace
  // licenses are non-exclusive and the listing stays live. purchase_type is set on
  // the PaymentIntent at checkout; absence means a (legacy) auction.
  if (paymentIntent.metadata.purchase_type === "marketplace") {
    await deliverMarketplaceLicense(a, tx);
  } else {
    await deliverExclusiveAuction(a, tx);
  }

  // Payout side is identical for both: with a connected account this was a
  // destination charge, so Stripe already moved the photographer's net as part of
  // the payment. Do NOT create a second transfer — just record it on THIS
  // transaction and notify. (transfer.created reconciles the final settled state.)
  const { data: photographer } = await supabaseAdmin
    .from("users")
    .select("stripe_account_id, id")
    .eq("id", tx.photographer_id)
    .single();

  const p = photographer as Pick<DbUser, "stripe_account_id" | "id"> | null;
  if (p?.stripe_account_id) {
    await supabaseAdmin
      .from("transactions")
      .update({
        payout_status: "in_transit",
        payout_initiated_at: new Date().toISOString(),
      })
      .eq("id", tx.id);

    await notifyPaymentReceived({
      photographerId: p.id,
      auctionId: a.id,
      amount: tx.photographer_payout,
    });
  }
}

// Exclusive auction win: one buyer, listing becomes terminal. The full-res file
// lives at the path stored in `full_url` (set from presign's `filePath`); sign that
// exact path. Flip the listing-level rights_transferred flag — the buyer pulls a
// signed URL on demand once paid (see GET /api/auctions/[id]).
// Exported for unit testing (not a route export — Next only treats `default`/`config` specially).
export async function deliverExclusiveAuction(a: DbAuction, tx: DbTransaction) {
  if (a.full_url) {
    const signedUrl = await storage.createDownloadUrl(a.full_url);
    if (!signedUrl) {
      console.error(`Could not sign full_url for auction ${a.id}`);
    } else {
      await supabaseAdmin
        .from("auctions")
        .update({ rights_transferred: true })
        .eq("id", a.id);
    }
  } else {
    console.error(`Auction ${a.id} has no full_url; cannot deliver content.`);
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: tx.buyer_id,
    type: "payment_received",
    auction_id: a.id,
    title: "📥 Content Ready for Download",
    body: `Your payment for "${a.title}" was successful. Your exclusive content and rights transfer are ready.`,
  });
}

// Non-exclusive marketplace license: the listing stays in 'marketplace' and must
// NOT flip rights_transferred (a listing-level, single-buyer flag). Each buyer's
// access is gated by their own succeeded transaction; they pull a per-buyer signed
// URL on demand (see GET /api/marketplace/[id]). Nothing terminal happens here.
export async function deliverMarketplaceLicense(
  a: DbAuction,
  tx: DbTransaction,
) {
  if (!a.full_url) {
    console.error(
      `Marketplace listing ${a.id} has no full_url; cannot deliver.`,
    );
  }

  // Bump license_count: "N licensed" social proof and the archive gate (B3 only
  // archives when license_count = 0). Read-modify-write matches the view_count
  // convention; a lost update can only undercount social proof — it can never let
  // a paid listing be archived (the count stays > 0).
  await supabaseAdmin
    .from("auctions")
    .update({ license_count: (a.license_count ?? 0) + 1 })
    .eq("id", a.id);

  // Archive-vs-payment race: the 30-day sweep can archive the listing while this
  // buyer is mid-checkout (transaction still pending, count still 0). The listing
  // now has a paid license, so "stays listed after each sale" applies — restore
  // it. Conditional on status='archived' so a listing the photographer already
  // relisted as a live auction is left untouched.
  if (a.status === "archived") {
    await supabaseAdmin
      .from("auctions")
      .update({ status: "marketplace" })
      .eq("id", a.id)
      .eq("status", "archived");
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: tx.buyer_id,
    type: "payment_received",
    auction_id: a.id,
    title: "📥 License Ready for Download",
    body: `Your purchase of "${a.title}" was successful. Your non-exclusive license and full-resolution download are ready.`,
  });
}

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const tx = await resolveTransaction(paymentIntent);
  if (!tx) return;
  await supabaseAdmin
    .from("transactions")
    .update({ payment_status: "failed", payment_intent_id: paymentIntent.id })
    .eq("id", tx.id);
  console.error(
    `Payment failed for transaction ${tx.id} (auction ${tx.auction_id}):`,
    paymentIntent.last_payment_error?.message,
  );
}

// Settlement keys off the transaction id carried on the PaymentIntent (set for both
// auction and marketplace checkouts). Older in-flight auction PaymentIntents from
// before this refactor carried only auction_id — fall back to the single
// transaction for that auction so they still settle.
export async function resolveTransaction(
  paymentIntent: Stripe.PaymentIntent,
): Promise<DbTransaction | null> {
  const transactionId = paymentIntent.metadata.transaction_id;
  if (transactionId) {
    const { data } = await supabaseAdmin
      .from("transactions")
      .select("*")
      .eq("id", transactionId)
      .single();
    return (data as DbTransaction) ?? null;
  }

  const auctionId = paymentIntent.metadata.auction_id;
  if (!auctionId) return null;
  const { data } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("auction_id", auctionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as DbTransaction) ?? null;
}

// Exported for unit testing.
export async function handleTransferCreated(transfer: Stripe.Transfer) {
  // Destination charges: Stripe creates the transfer itself, so nothing in our
  // code ever knew the transfer id up front. The join key we DO hold is the
  // charge — transfer.source_transaction is the charge id we stored on the
  // transaction at settlement (charge_id). Record the transfer id and mark the
  // payout settled.
  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id;
  if (!chargeId) return;
  await supabaseAdmin
    .from("transactions")
    .update({
      payout_id: transfer.id,
      payout_status: "paid",
      payout_completed_at: new Date().toISOString(),
    })
    .eq("charge_id", chargeId);
}

async function handlePayoutPaid(payout: Stripe.Payout) {
  console.log(`Payout ${payout.id} confirmed by bank`);
}

async function handleAccountUpdated(account: Stripe.Account) {
  const status =
    account.details_submitted && account.charges_enabled
      ? "active"
      : "restricted";
  await supabaseAdmin
    .from("users")
    .update({ stripe_account_status: status })
    .eq("stripe_account_id", account.id);
}

export default withErrorHandling(handler);
