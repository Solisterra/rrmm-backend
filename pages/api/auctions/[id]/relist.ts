import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { getUserFromRequest, supabaseAdmin } from "../../../../lib/supabase";
import { relistListing } from "../../../../lib/auction-engine";
import type { DbUser, DbAuction } from "../../../../lib/types";

const VALID_DURATIONS = [2, 4, 6];

// POST /api/auctions/:id/relist
// Owner (or admin) puts an ARCHIVED listing back up for sale. Body:
//   { mode: 'auction', reserve_price, duration_hours, fallback_price? }  — fresh auction
//   { mode: 'marketplace', fallback_price }                              — fixed price
// Route does auth + ownership + input validation; the status transition (and its
// archived-only race guard) lives in relistListing (auction-engine).
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;

  const { id } = req.query as { id: string };

  const { data: listing } = await supabaseAdmin
    .from("auctions")
    .select("id, photographer_id, status")
    .eq("id", id)
    .single();
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  const l = listing as Pick<DbAuction, "id" | "photographer_id" | "status">;

  // Ownership is the security gate: only the seller who owns it (or an admin) may
  // relist. Checked before the status check so callers can't probe others' listings.
  if (u.role !== "admin" && l.photographer_id !== u.id)
    return res
      .status(403)
      .json({ error: "You can only relist your own content" });
  if (l.status !== "archived")
    return res
      .status(400)
      .json({ error: "Only archived listings can be relisted" });

  const body = req.body as {
    mode?: string;
    reserve_price?: number | string;
    duration_hours?: number | string;
    fallback_price?: number | string | null;
  };

  if (body.mode !== "auction" && body.mode !== "marketplace")
    return res
      .status(400)
      .json({ error: "mode must be 'auction' or 'marketplace'" });

  if (body.mode === "auction") {
    const reservePrice = parseFloat(String(body.reserve_price));
    const durationHours = parseInt(String(body.duration_hours));
    if (!body.reserve_price || isNaN(reservePrice) || reservePrice < 25)
      return res.status(400).json({ error: "Minimum reserve price is $25" });
    if (!VALID_DURATIONS.includes(durationHours))
      return res
        .status(400)
        .json({ error: "Duration must be 2, 4, or 6 hours" });

    // Fallback price is optional for an auction relist (lets it fall back to the
    // marketplace again if it doesn't sell). Validate it only if provided.
    let fallbackPrice: number | null = null;
    if (body.fallback_price != null && String(body.fallback_price) !== "") {
      fallbackPrice = parseFloat(String(body.fallback_price));
      if (isNaN(fallbackPrice) || fallbackPrice <= 0)
        return res
          .status(400)
          .json({ error: "Fallback price must be greater than 0" });
    }

    const result = await relistListing({
      auctionId: id,
      mode: "auction",
      reservePrice,
      durationHours,
      fallbackPrice,
    });
    // The only engine error is the archived-only guard losing a race → 409.
    if (result.error) return res.status(409).json({ error: result.error });
    return res.status(200).json(result);
  }

  // marketplace mode — a fixed price is required.
  const fallbackPrice = parseFloat(String(body.fallback_price));
  if (!body.fallback_price || isNaN(fallbackPrice) || fallbackPrice <= 0)
    return res
      .status(400)
      .json({ error: "A marketplace price greater than 0 is required" });

  const result = await relistListing({
    auctionId: id,
    mode: "marketplace",
    fallbackPrice,
  });
  if (result.error) return res.status(409).json({ error: result.error });
  return res.status(200).json(result);
}

export default withErrorHandling(handler);
