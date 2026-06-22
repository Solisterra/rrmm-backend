import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import type { DbUser } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  const {
    auctionId,
    photographerId,
    from,
    to,
    limit = "50",
    offset = "0",
  } = req.query as Record<string, string | undefined>;

  let query = supabaseAdmin
    .from("attestation_audit_log")
    .select("*")
    .range(
      parseInt(offset ?? "0"),
      parseInt(offset ?? "0") + parseInt(limit ?? "50") - 1,
    );

  if (auctionId) query = query.eq("auction_id", auctionId);
  if (photographerId) query = query.eq("photographer_email", photographerId);
  if (from) query = query.gte("attested_at", from);
  if (to) query = query.lte("attested_at", to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  return res
    .status(200)
    .json({ attestations: data || [], count: data?.length ?? 0 });
}

export default withErrorHandling(handler);
