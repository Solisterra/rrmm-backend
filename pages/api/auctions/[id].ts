import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import { storage } from "../../../lib/storage";
import type { DbUser, DbAuction } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query as { id: string };
  if (req.method === "GET") return getAuction(req, res, id);
  if (req.method === "PATCH") return updateAuction(req, res, id);
  if (req.method === "DELETE") return cancelAuction(req, res, id);
  return res.status(405).json({ error: "Method not allowed" });
}

async function getAuction(
  req: NextApiRequest,
  res: NextApiResponse,
  id: string,
) {
  const user = await getUserFromRequest(req);

  const { data: auction, error } = await supabaseAdmin
    .from("auctions")
    .select(
      `*,
      users!photographer_id(id, handle, display_name, avatar_url, total_sales),
      bids(id, amount, bidder_id, is_winning, created_at, users!bidder_id(handle, display_name))`,
    )
    .eq("id", id)
    .single();

  if (error || !auction)
    return res.status(404).json({ error: "Auction not found" });

  const a = auction as DbAuction;
  await supabaseAdmin
    .from("auctions")
    .update({ view_count: a.view_count + 1 })
    .eq("id", id);

  const isBuyer = (user as DbUser | null)?.id === a.buyer_id;
  const hasPaid = a.status === "sold";
  const response = { ...a } as Record<string, unknown>;
  // `full_url` is a private-bucket path, not downloadable as-is. Only the paying
  // buyer gets a short-lived signed download URL; everyone else gets nothing.
  if (isBuyer && hasPaid && a.full_url) {
    response.full_url = await storage.createDownloadUrl(a.full_url);
  } else {
    delete response.full_url;
  }

  return res.status(200).json({ auction: response });
}

async function updateAuction(
  req: NextApiRequest,
  res: NextApiResponse,
  id: string,
) {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { data: auction } = await supabaseQuery(
    supabaseAdmin.from("auctions").select("*").eq("id", id).single(),
  );
  if (!auction) return res.status(404).json({ error: "Not found" });

  const a = auction as DbAuction;
  const u = user as DbUser;
  const isOwner = a.photographer_id === u.id;
  const isAdmin = u.role === "admin";
  if (!isOwner && !isAdmin) return res.status(403).json({ error: "Forbidden" });
  if (a.status === "active" && !isAdmin)
    return res.status(400).json({ error: "Cannot edit active auction" });

  const allowedFields = [
    "title",
    "description",
    "event_tag",
    "is_featured",
  ] as const;
  const updates: Partial<Record<(typeof allowedFields)[number], unknown>> = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  const { data, error } = await supabaseAdmin
    .from("auctions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ auction: data });
}

async function cancelAuction(
  req: NextApiRequest,
  res: NextApiResponse,
  id: string,
) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  const { data: auction } = await supabaseQuery(
    supabaseAdmin.from("auctions").select("status").eq("id", id).single(),
  );
  if (!auction) return res.status(404).json({ error: "Auction not found" });
  if ((auction as DbAuction).status === "sold")
    return res.status(400).json({ error: "Cannot cancel a sold auction" });

  await supabaseAdmin
    .from("auctions")
    .update({ status: "cancelled" })
    .eq("id", id);
  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
