import type {
  AuctionCategory,
  Exclusivity,
  ApplicationStatus,
  DbAuction,
  DbBuyerApplication,
  DbTransaction,
  FormattedAuction,
  FormattedApplication,
  FormattedTransaction,
} from "./types";

const CATEGORY_EMOJI: Record<AuctionCategory, string> = {
  "Launch Event": "🚀",
  "Test Event": "🔥",
  "Infrastructure": "🏗️",
  "Breaking": "⚡",
  "Scenic": "🌅",
  "Milestone": "🏆",
};

export function formatAuction(row: DbAuction & { users?: { handle?: string | null; display_name?: string | null; photographer_handle?: string | null } | null }): FormattedAuction {
  const now = Date.now();
  const endsAt = row.ends_at ? new Date(row.ends_at).getTime() : null;
  const minutesLeft = endsAt
    ? Math.max(0, Math.round((endsAt - now) / 60000))
    : (row.duration_hours ?? 0) * 60;

  const photographer =
    row.users?.handle ??
    row.users?.display_name ??
    row.users?.photographer_handle ??
    "Unknown";

  const currentBid = parseFloat(String(row.current_bid ?? 0));
  const reservePrice = parseFloat(String(row.reserve_price ?? 0));
  const minBid = currentBid > 0 ? Math.ceil(currentBid * 1.08) : reservePrice;

  const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
  const isNew = now - createdMs < 4 * 60 * 60 * 1000;

  return {
    id: row.id,
    photographer_id: row.photographer_id,
    title: row.title,
    category: row.category,
    photographer,
    emoji: CATEGORY_EMOJI[row.category] ?? "🌌",
    exclusive: row.exclusivity as Exclusivity,
    currentBid,
    minBid,
    bids: row.bid_count ?? 0,
    minutesLeft,
    bidHistory: [],
    hot: row.is_featured ?? false,
    isNew,
    preview_url: row.preview_url ?? null,
    watermark_url: row.watermark_url ?? null,
    full_url: row.full_url ?? null,
    event_tag: row.event_tag ?? null,
  };
}

export function formatApplication(row: DbBuyerApplication): FormattedApplication {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    channel: row.channel_name,
    note: row.note ?? "",
    platforms: row.platforms ?? [],
    appliedAt: row.created_at
      ? new Date(row.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "",
    status: row.status as ApplicationStatus,
  };
}

const PAYOUT_STATUS_MAP: Record<string, "paid" | "pending"> = {
  paid: "paid",
  in_transit: "pending",
  pending: "pending",
  failed: "pending",
};

export function formatTransaction(
  row: DbTransaction & {
    auctions?: { title?: string; category?: string };
    buyer?: { display_name?: string; handle?: string };
    auction_title?: string;
    auction_category?: string;
    buyer_display_name?: string;
  },
): FormattedTransaction {
  const auctionTitle = row.auctions?.title ?? row.auction_title ?? "Unknown Auction";
  const auctionCategory = row.auctions?.category ?? row.auction_category ?? null;
  const buyerName =
    row.buyer?.display_name ??
    row.buyer?.handle ??
    row.buyer_display_name ??
    "Verified Buyer";

  const status = PAYOUT_STATUS_MAP[row.payout_status] ?? "pending";
  const salePrice = parseFloat(String(row.gross_amount ?? 0));
  const net = parseFloat(String(row.photographer_payout ?? 0));

  return {
    id: row.id,
    title: auctionTitle,
    emoji: CATEGORY_EMOJI[auctionCategory as AuctionCategory] ?? "🏆",
    category: auctionCategory,
    buyer: buyerName,
    date: row.created_at
      ? new Date(row.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "",
    status,
    salePrice,
    net,
  };
}
