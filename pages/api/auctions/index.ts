import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import { formatAuction } from "../../../lib/format";
import type { DbUser, DbAuction, AuctionStatus } from "../../../lib/types";

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
    .select(
      "*, users!photographer_id(handle, display_name, avatar_url, verified)",
    )
    .eq("status", status as AuctionStatus)
    .order(sort, { ascending: sort === "ends_at" })
    .range(
      parseInt(String(offset)),
      parseInt(String(offset)) + parseInt(String(limit)) - 1,
    );

  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const auctions = ((data as DbAuction[] | null) ?? []).map((row) => {
    const { full_url: _full_url, ...rest } = formatAuction(row);
    return rest;
  });
  return res.status(200).json({ auctions });
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
  // Anyone with a verified seller capability can list; admins are exempt.
  if (
    (user as DbUser).role !== "admin" &&
    (user as DbUser).sell_status !== "verified"
  )
    return res
      .status(403)
      .json({ error: "Seller verification required to create listings" });

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
    listing_type,
    reserve_price,
    duration_hours,
    fallback_price,
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
    listing_type?: string;
    reserve_price?: number;
    duration_hours?: number;
    fallback_price?: number | string | null;
    event_tag?: string;
    attestation?: AttestationPayload;
  };

  // How the content sells. 'auction' (default) is the existing timed-bidding
  // path; 'marketplace' skips the auction entirely and, once approved, lists
  // at a fixed non-exclusive price (fallback_price doubles as that price).
  const listingType = listing_type ?? "auction";
  if (!["auction", "marketplace"].includes(listingType))
    return res
      .status(400)
      .json({ error: "listing_type must be 'auction' or 'marketplace'" });
  const isMarketplace = listingType === "marketplace";

  if (!title || !category || !content_type || !preview_url) {
    return res.status(400).json({ error: "Missing required content fields" });
  }
  if (!isMarketplace) {
    if (!exclusivity || !reserve_price)
      return res.status(400).json({ error: "Missing required content fields" });
    if (reserve_price < 25) {
      return res.status(400).json({ error: "Minimum reserve price is $25" });
    }
    if (![2, 4, 6].includes(parseInt(String(duration_hours)))) {
      return res
        .status(400)
        .json({ error: "Duration must be 2, 4, or 6 hours" });
    }
  }

  // Optional marketplace fallback price: the fixed, non-exclusive price the
  // listing sells at if the auction ends with no winning bid. Left blank, the
  // listing goes 'unsold' and rights revert as before. The 25–40%-of-reserve
  // guidance is a UI recommendation, not a server rule — only positivity is
  // enforced here.
  let fallbackPrice: number | null = null;
  if (fallback_price != null && String(fallback_price) !== "") {
    fallbackPrice = parseFloat(String(fallback_price));
    if (isNaN(fallbackPrice) || fallbackPrice <= 0)
      return res.status(400).json({
        error: "Fallback price must be greater than 0",
        detail:
          "Recommended: 25–40% of your reserve. Lower prices attract more buyers.",
      });
  }

  // Direct marketplace listings sell at a fixed non-exclusive price, so the
  // price itself is required (it rides in fallback_price, same column the
  // auction path falls back to).
  if (isMarketplace && fallbackPrice == null) {
    return res.status(400).json({
      error: "Marketplace price required",
      detail:
        "Set fallback_price — the fixed price buyers license this content at.",
    });
  }

  if (!attestation) {
    return res.status(400).json({
      error: "Ownership attestation required",
      detail:
        "All four attestation confirmations must be submitted with every listing.",
    });
  }

  const {
    confirmed_ownership,
    confirmed_unpublished,
    confirmed_no_third_party,
    confirmed_consequences,
  } = attestation;

  if (
    !confirmed_ownership ||
    !confirmed_unpublished ||
    !confirmed_no_third_party ||
    !confirmed_consequences
  ) {
    return res.status(400).json({
      error: "Incomplete attestation",
      detail:
        "All four ownership confirmations must be true. Listing rejected.",
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
      preview_url,
      watermark_url,
      full_url,
      file_size_mb,
      // Marketplace-direct rows: exclusivity is Non-Exclusive by definition;
      // reserve_price (NOT NULL) mirrors the price and never gates a bid;
      // duration_hours keeps its column default (no auction window). A non-null
      // marketplace_since on a *pending* row is the marker admin review uses to
      // publish straight to the marketplace instead of activating an auction —
      // auction-path rows only ever gain it after closing (B2), never while
      // pending. It is refreshed at approval so the 30-day clock starts then.
      exclusivity: isMarketplace ? "Non-Exclusive" : exclusivity,
      reserve_price: isMarketplace
        ? fallbackPrice
        : parseFloat(String(reserve_price)),
      ...(isMarketplace
        ? { marketplace_since: new Date().toISOString() }
        : { duration_hours: parseInt(String(duration_hours)) }),
      fallback_price: fallbackPrice,
      event_tag,
      status: "pending",
    })
    .select()
    .single();

  if (auctionErr) return res.status(500).json({ error: auctionErr.message });

  const auctionRow = auction as { id: string };
  const ipAddress =
    (req.headers["x-forwarded-for"] as string) ||
    req.socket?.remoteAddress ||
    "unknown";
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

  const ar = attestRecord as {
    id: string;
    attested_at: string;
    attestation_version: string;
  };

  await supabaseAdmin
    .from("auctions")
    .update({ attestation_id: ar.id, attested_at: ar.attested_at })
    .eq("id", auctionRow.id);

  return res.status(201).json({
    auction: formatAuction(auction as DbAuction),
    attestation: {
      id: ar.id,
      attested_at: ar.attested_at,
      version: ar.attestation_version,
    },
    message: isMarketplace
      ? "Listing submitted for review. Attestation recorded. Once approved it goes live on the marketplace at your fixed price."
      : "Listing submitted for review. Attestation recorded. Typically approved within 15 minutes.",
  });
}

export default withErrorHandling(handler);
