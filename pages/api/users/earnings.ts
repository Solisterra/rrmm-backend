import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import type { DbUser, DbTransaction } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;
  if (u.sell_status !== "verified")
    return res.status(403).json({ error: "Seller verification required" });

  const { data: transactions } = await supabaseQuery(
    supabaseAdmin
      .from("transactions")
      .select("*, auctions!auction_id(title, category, emoji:event_tag)")
      .eq("photographer_id", u.id)
      .order("created_at", { ascending: false }),
  );

  const monthly: Record<string, number> = {};
  for (const tx of (transactions as DbTransaction[]) || []) {
    if (tx.payout_status !== "paid") continue;
    const month = tx.created_at.slice(0, 7);
    monthly[month] =
      (monthly[month] ?? 0) + parseFloat(String(tx.photographer_payout));
  }

  const pending = ((transactions as DbTransaction[]) || [])
    .filter((tx) => tx.payout_status === "pending")
    .reduce((s, tx) => s + parseFloat(String(tx.photographer_payout)), 0);

  const { data: liveAuctions } = await supabaseQuery(
    supabaseAdmin
      .from("auctions")
      .select("id, title, current_bid, status")
      .eq("photographer_id", u.id)
      .eq("status", "active"),
  );

  return res.status(200).json({
    summary: {
      totalEarned: u.total_earned ?? 0,
      totalSales: u.total_sales ?? 0,
      pendingPayout: pending,
      avgSaleNet:
        u.total_sales > 0 ? (u.total_earned / u.total_sales).toFixed(2) : 0,
    },
    monthly,
    transactions: transactions || [],
    liveAuctions: liveAuctions || [],
  });
}

export default withErrorHandling(handler);
