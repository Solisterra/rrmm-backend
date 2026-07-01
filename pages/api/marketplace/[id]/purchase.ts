import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { getUserFromRequest, supabaseAdmin } from "../../../../lib/supabase";
import { createCheckoutSession } from "../../../../lib/stripe";
import { computeSplit } from "../../../../lib/money";
import type { DbUser, DbAuction } from "../../../../lib/types";

// First configured frontend origin — where Checkout redirects the buyer back to.
function frontendOrigin(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)[0];
}

// POST /api/marketplace/:id/purchase
// Non-exclusive, fixed-price buy of a marketplace listing. Self-service: any buyer
// (including the default 'marketplace' tier, which cannot bid) may purchase as long
// as they have a payment method on file. Unlike a won-auction checkout, the listing
// is NOT exclusive and stays live afterwards — many buyers can license the same
// content. We create ONE pending transaction row per purchase up front so the
// webhook can settle by transaction id; license_count is bumped only on success.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const { id } = req.query as { id: string };

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;
  if (u.role !== "buyer")
    return res.status(403).json({ error: "Buyer account required" });
  if (!u.stripe_customer_id)
    return res
      .status(400)
      .json({ error: "Payment method required. Please add a card first." });

  const { data: listing } = await supabaseAdmin
    .from("auctions")
    .select("*, users!photographer_id(stripe_account_id)")
    .eq("id", id)
    .single();

  if (!listing)
    return res.status(404).json({ error: "Marketplace listing not found" });

  const a = listing as DbAuction & { users?: { stripe_account_id?: string } };
  if (a.status !== "marketplace" || a.fallback_price == null)
    return res
      .status(400)
      .json({ error: "Listing is not available for purchase" });
  if (a.photographer_id === u.id)
    return res
      .status(403)
      .json({ error: "You cannot license your own content" });

  // Same money split the auction engine uses (single source of truth, lib/money).
  const {
    gross: grossAmount,
    platformFee,
    photographerPayout,
  } = computeSplit(parseFloat(String(a.fallback_price)));

  // One transaction row per license. payment_status stays 'pending' until the
  // webhook settles it by id. payment_intent_id is filled in then (the hosted
  // Checkout PaymentIntent doesn't exist yet).
  const { data: tx, error: txErr } = await supabaseAdmin
    .from("transactions")
    .insert({
      auction_id: a.id,
      buyer_id: u.id,
      photographer_id: a.photographer_id,
      gross_amount: grossAmount,
      platform_fee: platformFee,
      photographer_payout: photographerPayout,
    })
    .select("id")
    .single();

  if (txErr || !tx)
    return res
      .status(500)
      .json({ error: txErr?.message ?? "Could not start purchase" });

  const transactionId = (tx as { id: string }).id;
  const origin = frontendOrigin();
  const session = await createCheckoutSession({
    amount: grossAmount,
    buyerStripeId: u.stripe_customer_id,
    auctionId: a.id,
    transactionId,
    purchaseType: "marketplace",
    title: a.title,
    // Destination charge only if the photographer has a connected account.
    photographerAccountId: a.users?.stripe_account_id ?? null,
    successUrl: `${origin}/home?licensed=1&content=${a.id}`,
    cancelUrl: `${origin}/marketplace?purchase=0`,
  });

  return res.status(200).json({ url: session.url, transactionId });
}

export default withErrorHandling(handler);
