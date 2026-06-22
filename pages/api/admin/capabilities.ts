import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  formatUser,
  supabaseQuery,
} from "../../../lib/supabase";
import type { DbUser } from "../../../lib/types";

// Admin review of capability requests. A member who requested bidding ("buyer")
// or selling ("seller") shows up here while the matching status is "pending".
// Approving flips it to "verified" (grants the capability without touching the
// other one, so dual-capability members keep what they already have).
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  if (req.method === "GET") {
    const { data } = await supabaseQuery<DbUser[]>(
      supabaseAdmin
        .from("users")
        .select("*")
        .or("bid_status.eq.pending,sell_status.eq.pending")
        .order("created_at", { ascending: true }),
    );
    // formatUser already exposes bidStatus / sellStatus, so the client can tell
    // which capability (or both) is awaiting review.
    const pending = (data ?? []).map(formatUser);
    return res.status(200).json({ pending, count: pending.length });
  }

  if (req.method === "POST") {
    const { userId, capability, decision } = req.body as {
      userId?: string;
      capability?: "buyer" | "seller";
      decision?: "approved" | "rejected";
    };

    if (!userId) return res.status(400).json({ error: "userId required" });
    if (capability !== "buyer" && capability !== "seller")
      return res
        .status(400)
        .json({ error: "capability must be 'buyer' or 'seller'" });
    if (!decision || !["approved", "rejected"].includes(decision))
      return res
        .status(400)
        .json({ error: "Decision must be approved or rejected" });

    const column = capability === "buyer" ? "bid_status" : "sell_status";
    const newStatus = decision === "approved" ? "verified" : "rejected";

    const { data: updated, error } = await supabaseAdmin
      .from("users")
      .update({ [column]: newStatus })
      .eq("id", userId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await supabaseAdmin.from("notifications").insert({
      user_id: userId,
      type: decision === "approved" ? "content_approved" : "content_rejected",
      title:
        decision === "approved"
          ? "✓ Verification approved"
          : "Verification update",
      body:
        decision === "approved"
          ? `You can now ${capability === "buyer" ? "place bids" : "create listings"}.`
          : `Your ${capability === "buyer" ? "bidding" : "selling"} verification was not approved.`,
    });

    return res.status(200).json({
      success: true,
      user: formatUser(updated as DbUser),
      message: `${capability === "buyer" ? "Bidding" : "Selling"} ${decision}.`,
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withErrorHandling(handler);
