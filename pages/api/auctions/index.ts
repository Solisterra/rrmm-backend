import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import type { DbUser, AuctionStatus } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return getAuctions(req, res);
  if (req.method === "POST") return createAuction(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

async function getAuctions(req: NextApiRequest, res: NextApiResponse) {
  const {
    category,
    status = "active",
    sort = "ends_at",
    limit = 20,
    offset = 0,
  } = req.query as Record<string, string | undefined>;

  let query = supabaseAdmin
    .from("auctions")
    .select("*, users!photographer_id(handle, display_name, avatar_url, verified)")
    .eq("status", status as AuctionStatus)
    .order(sort, { ascending: sort === "ends_at" })
    .range(parseInt(String(offset)), parseInt(String(offset)) + parseInt(String(limit)) - 1);

  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const sanitized = (data || []).map(({ full_url: _full_url, ...a }: Record<string, unknown>) => a);
  return res.status(200).json({ auctions: sanitized });
}

interface AttestationPayload {
  confirmed_ownership: boolean;
  confirmed_unpublished: boolean;
  confirmed_no_third_party: boolean;
  confirmed_consequences: boolean;
}

async function createAuction(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if ((user as DbUser).role !== "photographer")
    return res.status(403).json({ error: "Photographers only" });
  if (!(user as DbUser).verified)
    return res.status(403).json({ error: "Account pending verification" });

  const {
    title,
    description,
    category,
    content_type,
    exclusivity,
    preview_url,
    watermark_url,
    full_url,
    file_size_mb,
    reserve_price,
    duration_hours,
    event_tag,
    attestation,
  } = req.body as {
    title?: string;
    description?: string;
    category?: string;
    content_type?: string;
    exclusivity?: string;
    preview_url?: string;
    watermark_url?: string;
    full_url?: string;
    file_size_mb?: number;
    reserve_price?: number;
    duration_hours?: number;
    event_tag?: string;
    attestation?: AttestationPayload;
  };

  if (!title || !category || !content_type || !exclusivity || !preview_url || !reserve_price) {
    return res.status(400).json({ error: "Missing required content fields" });
  }
  if (reserve_price < 25) {
    return res.status(400).json({ error: "Minimum reserve price is $25" });
  }
  if (![2, 4, 6].includes(parseInt(String(duration_hours)))) {
    return res.status(400).json({ error: "Duration must be 2, 4, or 6 hours" });
  }

  if (!attestation) {
    return res.status(400).json({
      error: "Ownership attestation required",
      detail: "All four attestation confirmations must be submitted with every listing.",
    });
  }

  const { confirmed_ownership, confirmed_unpublished, confirmed_no_third_party, confirmed_consequences } = attestation;

  if (!confirmed_ownership || !confirmed_unpublished || !confirmed_no_third_party || !confirmed_consequences) {
    return res.status(400).json({
      error: "Incomplete attestation",
      detail: "All four ownership confirmations must be true. Listing rejected.",
      missing: {
        confirmed_ownership: !confirmed_ownership,
        confirmed_unpublished: !confirmed_unpublished,
        confirmed_no_third_party: !confirmed_no_third_party,
        confirmed_consequences: !confirmed_consequences,
      },
    });
  }

  const { data: auction, error: auctionErr } = await supabaseAdmin
    .from("auctions")
    .insert({
      photographer_id: (user as DbUser).id,
      title,
      description,
      category,
      content_type,
      exclusivity,
      preview_url,
      watermark_url,
      full_url,
      file_size_mb,
      reserve_price: parseFloat(String(reserve_price)),
      duration_hours: parseInt(String(duration_hours)),
      event_tag,
      status: "pending",
    })
    .select()
    .single();

  if (auctionErr) return res.status(500).json({ error: auctionErr.message });

  const auctionRow = auction as { id: string };
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket?.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  const sessionId = req.headers["x-session-id"] as string | undefined;

  const { data: attestRecord, error: attestErr } = await supabaseAdmin
    .from("attestations")
    .insert({
      auction_id: auctionRow.id,
      photographer_id: (user as DbUser).id,
      confirmed_ownership: true,
      confirmed_unpublished: true,
      confirmed_no_third_party: true,
      confirmed_consequences: true,
      attested_at: new Date().toISOString(),
      ip_address: ipAddress,
      user_agent: userAgent,
      session_id: sessionId ?? null,
      attestation_version: "v1.0",
    })
    .select()
    .single();

  if (attestErr) {
    await supabaseAdmin.from("auctions").delete().eq("id", auctionRow.id);
    return res.status(500).json({
      error: "Failed to record attestation. Listing not submitted.",
      detail: attestErr.message,
    });
  }

  const ar = attestRecord as { id: string; attested_at: string; attestation_version: string };

  await supabaseAdmin
    .from("auctions")
    .update({ attestation_id: ar.id, attested_at: ar.attested_at })
    .eq("id", auctionRow.id);

  return res.status(201).json({
    auction: { ...auction, attestation_id: ar.id },
    attestation: {
      id: ar.id,
      attested_at: ar.attested_at,
      version: ar.attestation_version,
    },
    message: "Listing submitted for review. Attestation recorded. Typically approved within 15 minutes.",
  });
}

export default withErrorHandling(handler);
