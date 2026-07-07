import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import { activateAuction } from "../../../lib/auction-engine";
import {
  notifyContentApproved,
  notifyContentRejected,
} from "../../../lib/notifications";
import { formatAuction } from "../../../lib/format";
import type { DbUser, DbAuction, ContentDecision } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  if (req.method === "GET") {
    const { data } = await supabaseQuery(
      supabaseAdmin
        .from("auctions")
        .select(
          "*, users!photographer_id(handle, display_name, email, total_sales, verified)",
        )
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
    );
    const pending = ((data as DbAuction[]) || []).map(formatAuction);
    return res.status(200).json({ pending, count: pending.length });
  }

  if (req.method === "POST") {
    const { auctionId, decision, notes } = req.body as {
      auctionId?: string;
      decision?: ContentDecision;
      notes?: string;
    };

    if (!decision || !["approved", "rejected", "flagged"].includes(decision))
      return res.status(400).json({ error: "Invalid decision" });

    await supabaseAdmin.from("content_reviews").insert({
      auction_id: auctionId,
      reviewer_id: (user as DbUser).id,
      decision,
      notes,
    });

    const { data: auction } = await supabaseAdmin
      .from("auctions")
      .select("photographer_id, title, status, marketplace_since")
      .eq("id", auctionId)
      .single();
    if (!auction) return res.status(404).json({ error: "Auction not found" });

    const a = auction as {
      photographer_id: string;
      title: string;
      status: string;
      marketplace_since: string | null;
    };

    if (decision === "approved") {
      // A pending row with marketplace_since set is a direct-to-marketplace
      // listing (the create endpoint stamps it as the marker; auction-path rows
      // only gain marketplace_since after closing, never while pending). It
      // publishes at its fixed price instead of activating an auction; the
      // timestamp is refreshed so the 30-day archive clock starts at approval.
      if (a.status === "pending" && a.marketplace_since != null) {
        await supabaseAdmin
          .from("auctions")
          .update({
            status: "marketplace",
            marketplace_since: new Date().toISOString(),
          })
          .eq("id", auctionId)
          .eq("status", "pending");
        await notifyContentApproved({
          photographerId: a.photographer_id,
          auctionId: auctionId!,
          marketplace: true,
        });
        return res.status(200).json({
          success: true,
          message: "Listing approved and published to the marketplace",
        });
      }

      await activateAuction(auctionId!);
      await notifyContentApproved({
        photographerId: a.photographer_id,
        auctionId: auctionId!,
      });
      return res
        .status(200)
        .json({
          success: true,
          message: "Auction activated and buyers notified",
        });
    } else {
      await supabaseAdmin
        .from("auctions")
        .update({ status: "cancelled" })
        .eq("id", auctionId);
      await notifyContentRejected({
        photographerId: a.photographer_id,
        auctionId: auctionId!,
        reason: notes || "Content did not meet platform standards",
      });
      return res
        .status(200)
        .json({
          success: true,
          message: "Auction rejected and photographer notified",
        });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withErrorHandling(handler);
