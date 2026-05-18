import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { getUserFromRequest } from "../../../../lib/supabase";
import { placeBid } from "../../../../lib/auction-engine";
import type { DbUser } from "../../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const u = user as DbUser;
  if (u.role !== "buyer") return res.status(403).json({ error: "Verified buyer account required" });
  if (!u.verified) return res.status(403).json({ error: "Buyer account pending verification" });
  if (!u.stripe_customer_id)
    return res.status(400).json({ error: "Payment method required. Please add a card to your account." });

  const { id: auctionId } = req.query as { id: string };
  const { amount, proxyMax } = req.body as { amount?: string | number; proxyMax?: string | number };

  if (!amount || isNaN(Number(amount)))
    return res.status(400).json({ error: "Valid bid amount required" });

  const result = await placeBid({
    auctionId,
    bidderId: u.id,
    amount: parseFloat(String(amount)),
    proxyMax: proxyMax ? parseFloat(String(proxyMax)) : null,
  });

  if (result.error) return res.status(400).json({ error: result.error });
  return res.status(200).json(result);
}

export default withErrorHandling(handler);
