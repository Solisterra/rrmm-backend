import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import { storage } from "../../../lib/storage";
import { formatMarketItem } from "../../../lib/format";
import type { DbAuction, DbUser } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query as { id: string };
  if (req.method === "GET") return getMarketItem(req, res, id);
  return res.status(405).json({ error: "Method not allowed" });
}

async function getMarketItem(
  req: NextApiRequest,
  res: NextApiResponse,
  id: string,
) {
  const { data: auction, error } = await supabaseAdmin
    .from("auctions")
    .select(
      "*, users!photographer_id(id, handle, display_name, avatar_url, total_sales)",
    )
    .eq("id", id)
    .single();

  if (error || !auction)
    return res.status(404).json({ error: "Marketplace listing not found" });

  const a = auction as DbAuction;

  // Per-buyer delivery: a buyer with a settled (succeeded) transaction for this
  // content gets a short-lived signed download URL. Non-exclusive, so many buyers
  // can each hold one — this is the read side of the webhook's per-buyer settlement
  // (there is no listing-level rights_transferred flag for marketplace). Everyone
  // else gets null.
  let hasPaidLicense = false;
  const user = await getUserFromRequest(req);
  if (user) {
    const { data: paidTx } = await supabaseAdmin
      .from("transactions")
      .select("id")
      .eq("auction_id", a.id)
      .eq("buyer_id", (user as DbUser).id)
      .eq("payment_status", "succeeded")
      .limit(1)
      .maybeSingle();
    hasPaidLicense = !!paidTx;
  }

  // A paid license is perpetual: the holder keeps access even after the listing
  // leaves the marketplace (archived, or relisted as an auction). Everyone else
  // only ever sees live marketplace listings.
  if (a.status !== "marketplace" && !hasPaidLicense)
    return res.status(404).json({ error: "Marketplace listing not found" });

  if (a.status === "marketplace") {
    await supabaseAdmin
      .from("auctions")
      .update({ view_count: (a.view_count ?? 0) + 1 })
      .eq("id", id);
  }

  const downloadUrl =
    hasPaidLicense && a.full_url
      ? await storage.createDownloadUrl(a.full_url)
      : null;

  return res.status(200).json({ item: formatMarketItem(a), downloadUrl });
}

export default withErrorHandling(handler);
