import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { buffer } from "micro";
import Stripe from "stripe";
import { supabaseAdmin } from "../../../lib/supabase";
import { initiatePhotographerPayout } from "../../../lib/stripe";
import { notifyPaymentReceived } from "../../../lib/notifications";
import type { DbAuction, DbUser } from "../../../lib/types";

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
    event = getStripe().webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET!);
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

async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const auctionId = paymentIntent.metadata.auction_id;
  if (!auctionId) return;

  await supabaseAdmin
    .from("transactions")
    .update({ payment_status: "succeeded", charge_id: paymentIntent.latest_charge })
    .eq("payment_intent_id", paymentIntent.id);

  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", auctionId)
    .single();
  if (!auction) return;

  const a = auction as DbAuction;
  // The full-res file lives at the path stored in `full_url` (set from presign's
  // `filePath` = `${photographer_id}/${fileId}.${ext}`). Sign that exact path —
  // reconstructing it from the auction id does not match what was uploaded.
  if (a.full_url) {
    const { data: signedUrl, error: signErr } = await supabaseAdmin.storage
      .from("fullres")
      .createSignedUrl(a.full_url, 60 * 60 * 24 * 7);

    if (signErr || !signedUrl) {
      console.error(`Could not sign full_url for auction ${auctionId}:`, signErr?.message);
    } else {
      await supabaseAdmin.from("auctions").update({ rights_transferred: true }).eq("id", auctionId);
    }
  } else {
    console.error(`Auction ${auctionId} has no full_url; cannot deliver content.`);
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: a.buyer_id,
    type: "payment_received",
    auction_id: auctionId,
    title: "📥 Content Ready for Download",
    body: `Your payment for "${a.title}" was successful. Your exclusive content and rights transfer are ready.`,
  });

  const { data: photographer } = await supabaseAdmin
    .from("users")
    .select("stripe_account_id, id")
    .eq("id", a.photographer_id)
    .single();

  const p = photographer as Pick<DbUser, "stripe_account_id" | "id"> | null;
  if (p?.stripe_account_id) {
    const transfer = await initiatePhotographerPayout({
      photographerAccountId: p.stripe_account_id,
      amount: a.photographer_payout!,
      auctionId,
    });

    await supabaseAdmin.from("transactions").update({
      payout_id: transfer.id,
      payout_status: "in_transit",
      payout_initiated_at: new Date().toISOString(),
    }).eq("auction_id", auctionId);

    await notifyPaymentReceived({ photographerId: p.id, auctionId, amount: a.photographer_payout! });
  }
}

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const auctionId = paymentIntent.metadata.auction_id;
  if (!auctionId) return;
  await supabaseAdmin
    .from("transactions")
    .update({ payment_status: "failed" })
    .eq("payment_intent_id", paymentIntent.id);
  console.error(`Payment failed for auction ${auctionId}:`, paymentIntent.last_payment_error?.message);
}

async function handleTransferCreated(transfer: Stripe.Transfer) {
  await supabaseAdmin.from("transactions").update({
    payout_status: "paid",
    payout_completed_at: new Date().toISOString(),
  }).eq("payout_id", transfer.id);
}

async function handlePayoutPaid(payout: Stripe.Payout) {
  console.log(`Payout ${payout.id} confirmed by bank`);
}

async function handleAccountUpdated(account: Stripe.Account) {
  const status = account.details_submitted && account.charges_enabled ? "active" : "restricted";
  await supabaseAdmin.from("users").update({ stripe_account_status: status }).eq("stripe_account_id", account.id);
}

export default withErrorHandling(handler);
