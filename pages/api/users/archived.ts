import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import { formatArchivedListing } from "../../../lib/format";
import type { DbUser, DbAuction } from "../../../lib/types";

// GET /api/users/archived — the signed-in photographer's ARCHIVED listings:
// marketplace content the B3 sweep retired after 30 days with no license sold.
// Rights reverted on archive, so every row here is a relist candidate
// (POST /api/auctions/:id/relist). Photographer-scoped, mirroring /users/bids
// and /users/earnings — GET /auctions?status=archived is deliberately NOT
// user-scoped and must not be used for this.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;
  // Same seller gate as /users/earnings — the archive lives on the seller
  // dashboard, and only sellers can own listings in the first place.
  if (u.sell_status !== "verified")
    return res.status(403).json({ error: "Seller verification required" });

  const { data } = await supabaseQuery<DbAuction[]>(
    supabaseAdmin
      .from("auctions")
      .select("*")
      .eq("photographer_id", u.id)
      .eq("status", "archived")
      // updated_at is the archive flip time — most recently archived first.
      .order("updated_at", { ascending: false }),
  );

  const archived = (data ?? []).map(formatArchivedListing);
  return res.status(200).json({ archived });
}

export default withErrorHandling(handler);
