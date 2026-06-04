import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import { formatTransaction } from "../../../lib/format";
import type { DbUser, DbTransaction } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  const [
    { count: activeAuctions },
    { count: pendingReview },
    { count: totalUsers },
    { data: recentTransactions },
    { data: recentBids },
  ] = await Promise.all([
    supabaseAdmin.from("auctions").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabaseAdmin.from("auctions").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabaseAdmin.from("users").select("*", { count: "exact", head: true }),
    supabaseAdmin.from("transactions").select("*, auctions!auction_id(title, category), buyer:users!buyer_id(display_name, handle)").order("created_at", { ascending: false }).limit(10),
    supabaseAdmin.from("bids").select("amount, created_at").gte("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);

  const dailyGMV = (recentBids as Array<{ amount: string }> | null || []).reduce(
    (s, b) => s + parseFloat(b.amount),
    0,
  );
  const totalGMV = (recentTransactions as Array<{ gross_amount: string }> | null || []).reduce(
    (s, t) => s + parseFloat(t.gross_amount),
    0,
  );

  return res.status(200).json({
    stats: {
      activeAuctions: activeAuctions ?? 0,
      pendingReview: pendingReview ?? 0,
      totalUsers: totalUsers ?? 0,
      dailyGMV,
      recentGMV: totalGMV,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recentTransactions: (recentTransactions as any[] || []).map(formatTransaction),
  });
}

export default withErrorHandling(handler);
