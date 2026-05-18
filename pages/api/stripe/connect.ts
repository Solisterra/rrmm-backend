import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { getUserFromRequest, supabaseAdmin } from "../../../lib/supabase";
import { createConnectOnboardingLink, createPaymentIntent } from "../../../lib/stripe";
import type { DbUser, DbAuction } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return getOnboardingLink(req, res);
  if (req.method === "POST") return createIntent(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

async function getOnboardingLink(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "photographer")
    return res.status(403).json({ error: "Photographers only" });

  const u = user as DbUser;
  if (!u.stripe_account_id)
    return res.status(400).json({ error: "No Stripe account found" });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const link = await createConnectOnboardingLink(
    u.stripe_account_id,
    `${appUrl}/account?stripe=success`,
    `${appUrl}/account?stripe=refresh`,
  );
  return res.status(200).json({ url: link.url });
}

async function createIntent(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "buyer")
    return res.status(403).json({ error: "Buyers only" });

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
  if (a.buyer_id !== u.id) return res.status(403).json({ error: "You did not win this auction" });
  if (a.status !== "sold") return res.status(400).json({ error: "Auction not yet closed" });

  const intent = await createPaymentIntent({
    amount: a.sale_price!,
    buyerStripeId: u.stripe_customer_id,
    auctionId: auctionId!,
    photographerAccountId: a.users?.stripe_account_id!,
  });

  await supabaseAdmin
    .from("transactions")
    .update({ payment_intent_id: intent.id, payment_status: "processing" })
    .eq("auction_id", auctionId);

  return res.status(200).json({ clientSecret: intent.client_secret });
}

export default withErrorHandling(handler);
