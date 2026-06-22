import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  formatUser,
  supabaseQuery,
} from "../../../lib/supabase";
import type { DbUser } from "../../../lib/types";

// Photographer ACCOUNT approval. Photographers are created unverified
// (auth/sync.ts) and cannot create listings until an admin approves the
// account here, which sets `verified = true`. Buyer verification (which gates
// bidding) is a separate flow handled by /api/access/review.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  if (req.method === "GET") {
    // Pending = photographers awaiting account approval.
    const { data } = await supabaseQuery(
      supabaseAdmin
        .from("users")
        .select("*")
        .eq("role", "photographer")
        .eq("verified", false)
        .order("created_at", { ascending: true }),
    );
    const pending = ((data as DbUser[] | null) ?? []).map(formatUser);
    return res.status(200).json({ pending, count: pending.length });
  }

  if (req.method === "POST") {
    const { photographerId, decision } = req.body as {
      photographerId?: string;
      decision?: "approved" | "rejected";
    };

    if (!photographerId)
      return res.status(400).json({ error: "photographerId required" });
    if (!decision || !["approved", "rejected"].includes(decision))
      return res
        .status(400)
        .json({ error: "Decision must be approved or rejected" });

    const { data: target } = await supabaseAdmin
      .from("users")
      .select("id, role")
      .eq("id", photographerId)
      .single();
    if (!target)
      return res.status(404).json({ error: "Photographer not found" });
    if ((target as DbUser).role !== "photographer")
      return res
        .status(400)
        .json({ error: "Target user is not a photographer" });

    // Approve = verify the account (can now list). Reject = leave unverified.
    const { data: updated, error } = await supabaseAdmin
      .from("users")
      .update({ verified: decision === "approved" })
      .eq("id", photographerId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      success: true,
      user: formatUser(updated as DbUser),
      message:
        decision === "approved"
          ? "Photographer approved and verified. They can now create listings."
          : "Photographer left unverified.",
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withErrorHandling(handler);
