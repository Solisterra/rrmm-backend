import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest, supabaseQuery } from "../../../lib/supabase";
import type { DbUser } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const u = user as DbUser;

  if (req.method === "GET") {
    const { data } = await supabaseQuery(
      supabaseAdmin
        .from("watchlist")
        .select("auction_id, created_at, auctions!auction_id(*)")
        .eq("user_id", u.id)
        .order("created_at", { ascending: false }),
    );
    return res.status(200).json({
      watchlist: (data as Array<{ auctions: Record<string, unknown>; created_at: string }> | null || []).map((w) => ({
        ...w.auctions,
        watchedAt: w.created_at,
      })),
    });
  }

  if (req.method === "POST") {
    const { auctionId } = req.body as { auctionId?: string };
    if (!auctionId) return res.status(400).json({ error: "auctionId required" });
    const { data, error } = await supabaseAdmin
      .from("watchlist")
      .upsert(
        { user_id: u.id, auction_id: auctionId },
        { onConflict: "user_id,auction_id" },
      )
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ success: true, item: data });
  }

  if (req.method === "DELETE") {
    const { auctionId } = req.body as { auctionId?: string };
    await supabaseAdmin
      .from("watchlist")
      .delete()
      .eq("user_id", u.id)
      .eq("auction_id", auctionId);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withErrorHandling(handler);
