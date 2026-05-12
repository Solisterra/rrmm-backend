import { withErrorHandling } from "../../../lib/api.js";
/**
 * POST /api/stripe/webhook
 * Handles Stripe events: payment succeeded → release content + payout photographer
 */
import { buffer } from "micro";
import Stripe from "stripe";
import { supabaseAdmin } from "../../../lib/supabase.js";
import { initiatePhotographerPayout } from "../../../lib/stripe.js";
import { notifyPaymentReceived } from "../../../lib/notifications.js";

export const config = { api: { bodyParser: false } };

let _stripe = null;
const getStripe = () => (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY));

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(event.data.object);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;
      case "transfer.created":
        await handleTransferCreated(event.data.object);
        break;
      case "payout.paid":
        await handlePayoutPaid(event.data.object);
        break;
      case "account.updated":
        await handleAccountUpdated(event.data.object);
        break;
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }

  return res.status(200).json({ received: true });
}

async function handlePaymentSucceeded(paymentIntent) {
  const auctionId = paymentIntent.metadata.auction_id;
  if (!auctionId) return;

  await supabaseAdmin
    .from("transactions")
    .update({
      payment_status: "succeeded",
      charge_id: paymentIntent.latest_charge,
    })
    .eq("payment_intent_id", paymentIntent.id);

  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", auctionId)
    .single();

  if (!auction) return;

  // Mark rights as transferred and generate a 7-day signed download URL
  const { data: signedUrl } = await supabaseAdmin.storage
    .from("fullres")
    .createSignedUrl(
      `${auction.photographer_id}/${auctionId}`,
      60 * 60 * 24 * 7,
    );

  if (signedUrl) {
    await supabaseAdmin
      .from("auctions")
      .update({ rights_transferred: true })
      .eq("id", auctionId);
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: auction.buyer_id,
    type: "payment_received",
    auction_id: auctionId,
    title: "📥 Content Ready for Download",
    body: `Your payment for "${auction.title}" was successful. Your exclusive content and rights transfer are ready.`,
  });

  const { data: photographer } = await supabaseAdmin
    .from("users")
    .select("stripe_account_id, id")
    .eq("id", auction.photographer_id)
    .single();

  if (photographer?.stripe_account_id) {
    const transfer = await initiatePhotographerPayout({
      photographerAccountId: photographer.stripe_account_id,
      amount: auction.photographer_payout,
      auctionId,
    });

    await supabaseAdmin
      .from("transactions")
      .update({
        payout_id: transfer.id,
        payout_status: "in_transit",
        payout_initiated_at: new Date().toISOString(),
      })
      .eq("auction_id", auctionId);

    await notifyPaymentReceived({
      photographerId: photographer.id,
      auctionId,
      amount: auction.photographer_payout,
    });
  }
}

async function handlePaymentFailed(paymentIntent) {
  const auctionId = paymentIntent.metadata.auction_id;
  if (!auctionId) return;

  await supabaseAdmin
    .from("transactions")
    .update({ payment_status: "failed" })
    .eq("payment_intent_id", paymentIntent.id);

  console.error(
    `Payment failed for auction ${auctionId}:`,
    paymentIntent.last_payment_error?.message,
  );
}

async function handleTransferCreated(transfer) {
  await supabaseAdmin
    .from("transactions")
    .update({
      payout_status: "paid",
      payout_completed_at: new Date().toISOString(),
    })
    .eq("payout_id", transfer.id);
}

async function handlePayoutPaid(payout) {
  // Payout landed in photographer's bank — already marked paid in handleTransferCreated
  console.log(`Payout ${payout.id} confirmed by bank`);
}

async function handleAccountUpdated(account) {
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
