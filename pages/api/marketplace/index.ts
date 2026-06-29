import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin } from "../../../lib/supabase";
import { formatMarketItem } from "../../../lib/format";
import type { DbAuction } from "../../../lib/types";

// Whitelisted sort columns → ascending? Marketplace defaults to most-licensed
// first (social proof), unlike auctions which sort by ends_at.
const SORTS: Record<string, { column: string; ascending: boolean }> = {
  licensed: { column: "license_count", ascending: false },
  newest: { column: "marketplace_since", ascending: false },
  price_low: { column: "fallback_price", ascending: true },
  price_high: { column: "fallback_price", ascending: false },
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return listMarketplace(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

async function listMarketplace(req: NextApiRequest, res: NextApiResponse) {
  const {
    category,
    sort = "licensed",
    limit = 24,
    offset = 0,
  } = req.query as Record<string, string | undefined>;

  const order = SORTS[sort as string] ?? SORTS.licensed;

  let query = supabaseAdmin
    .from("auctions")
    .select(
      "*, users!photographer_id(handle, display_name, avatar_url, verified)",
    )
    .eq("status", "marketplace")
    // A marketplace listing must have a fixed price to be buyable.
    .not("fallback_price", "is", null)
    .order(order.column, { ascending: order.ascending })
    .range(
      parseInt(String(offset)),
      parseInt(String(offset)) + parseInt(String(limit)) - 1,
    );

  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const items = ((data as DbAuction[] | null) ?? []).map(formatMarketItem);
  return res.status(200).json({ items });
}

export default withErrorHandling(handler);
