import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { getUserFromRequest, supabaseAdmin } from "../../../lib/supabase";
import {
  createConnectOnboardingLink,
  createCheckoutSession,
} from "../../../lib/stripe";
import type { DbUser, DbAuction } from "../../../lib/types";

// First configured frontend origin — where Checkout redirects the buyer back to.
function frontendOrigin(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)[0];
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return getOnboardingLink(req, res);
  if (req.method === "POST") return createCheckout(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

async function getOnboardingLink(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).sell_status !== "verified")
    return res.status(403).json({ error: "Seller verification required" });

  const u = user as DbUser;
  if (!u.stripe_account_id)
    return res.status(400).json({ error: "No Stripe account found" });

  const origin = frontendOrigin();
  const link = await createConnectOnboardingLink(
    u.stripe_account_id,
    `${origin}/earnings?stripe=success`,
    `${origin}/earnings?stripe=refresh`,
  );
  return res.status(200).json({ url: link.url });
}

async function createCheckout(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).bid_status !== "verified")
    return res.status(403).json({ error: "Verified buyer account required" });

  const u = user as DbUser;
  if (!u.stripe_customer_id)
    return res.status(400).json({ error: "No payment method on file" });

  const { auctionId } = req.body as { auctionId?: string };
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*, users!photographer_id(stripe_account_id)")
    .eq("id", auctionId)
    .single();

  if (!auction) return res.status(404).json({ error: "Auction not found" });

  const a = auction as DbAuction & { users?: { stripe_account_id?: string } };
  if (a.buyer_id !== u.id)
    return res.status(403).json({ error: "You did not win this auction" });
  if (a.status !== "sold")
    return res.status(400).json({ error: "Auction not yet closed" });

  // The transaction row was created when the auction closed (closeAuction). The
  // webhook settles by this id, not by auction_id — the unified settlement path.
  const { data: tx } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("auction_id", auctionId!)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const origin = frontendOrigin();
  const session = await createCheckoutSession({
    amount: a.sale_price!,
    buyerStripeId: u.stripe_customer_id,
    auctionId: auctionId!,
    transactionId: (tx as { id: string } | null)?.id,
    purchaseType: "auction",
    title: a.title,
    // Destination charge only if the photographer has a connected account.
    photographerAccountId: a.users?.stripe_account_id ?? null,
    successUrl: `${origin}/home?paid=1&auction=${auctionId}`,
    cancelUrl: `${origin}/home?paid=0`,
  });

  // Payment state is settled by the webhook (payment_intent.succeeded), keyed off
  // the transaction id we put on the PaymentIntent — so nothing to persist here.
  return res.status(200).json({ url: session.url });
}

export default withErrorHandling(handler);
