import { supabaseAdmin } from "./supabase";
import {
  notifyOutbid,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyWatchlistUrgent,
} from "./notifications";
import type {
  PlaceBidParams,
  PlaceBidResult,
  CloseAuctionResult,
  ActivateAuctionResult,
  DbAuction,
  DbBid,
  DbUser,
} from "./types";

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PCT || "0.20");
const AUTO_EXTEND_MINUTES = 5;
const AUTO_EXTEND_TRIGGER_MINUTES = 5;
const MAX_EXTENSIONS = 6;

// ── Place a bid ───────────────────────────────────────────────────────────────

export async function placeBid({
  auctionId,
  bidderId,
  amount,
  proxyMax = null,
}: PlaceBidParams): Promise<PlaceBidResult> {
  const { data: auction, error: aErr } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", auctionId)
    .single();
  if (aErr || !auction) return { error: "Auction not found" };
  const a = auction as DbAuction;
  if (a.status !== "active") return { error: `Auction is ${a.status}` };
  if (new Date() > new Date(a.ends_at!)) return { error: "Auction has ended" };

  const minBid =
    a.current_bid > 0
      ? Math.ceil(a.current_bid * 1.05)
      : a.reserve_price;
  if (amount < minBid) return { error: `Bid must be at least $${minBid}` };
  if (bidderId === a.photographer_id)
    return { error: "Photographers cannot bid on own listings" };

  const { data: currentWinner } = await supabaseAdmin
    .from("bids")
    .select("*")
    .eq("auction_id", auctionId)
    .eq("is_winning", true)
    .single();
  const winner = currentWinner as DbBid | null;

  if (
    winner?.is_proxy &&
    (winner.proxy_max ?? 0) > amount &&
    winner.bidder_id !== bidderId
  ) {
    const counterBid = Math.min(amount + 50, winner.proxy_max!);
    await _recordBid({ auctionId, bidderId: winner.bidder_id, amount: counterBid, isProxy: true, proxyMax: winner.proxy_max, isWinning: true });
    await _recordBid({ auctionId, bidderId, amount, isProxy: false, proxyMax: null, isWinning: false });
    await supabaseAdmin
      .from("auctions")
      .update({ current_bid: counterBid, bid_count: a.bid_count + 2 })
      .eq("id", auctionId);
    await notifyOutbid({ bidderId, auctionId, newBid: counterBid });
    return { success: true, winning: false, currentBid: counterBid, message: "Outbid by proxy" };
  }

  if (winner) {
    await supabaseAdmin
      .from("bids")
      .update({ is_winning: false, outbid_at: new Date().toISOString() })
      .eq("id", winner.id);
    await notifyOutbid({ bidderId: winner.bidder_id, auctionId, newBid: amount });
  }

  await _recordBid({ auctionId, bidderId, amount, isProxy: !!proxyMax, proxyMax, isWinning: true });

  const endsAt = new Date(a.ends_at!);
  const now = new Date();
  const minutesLeft = (endsAt.getTime() - now.getTime()) / 60000;
  let newEndsAt = a.ends_at!;

  if (minutesLeft <= AUTO_EXTEND_TRIGGER_MINUTES && a.extension_count < MAX_EXTENSIONS) {
    newEndsAt = new Date(endsAt.getTime() + AUTO_EXTEND_MINUTES * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("auctions")
      .update({
        current_bid: amount,
        bid_count: a.bid_count + 1,
        ends_at: newEndsAt,
        auto_extended: true,
        extension_count: a.extension_count + 1,
      })
      .eq("id", auctionId);
  } else {
    await supabaseAdmin
      .from("auctions")
      .update({ current_bid: amount, bid_count: a.bid_count + 1 })
      .eq("id", auctionId);
  }

  if (minutesLeft <= 30) {
    await notifyWatchlistUrgent({ auctionId, minutesLeft: Math.round(minutesLeft) });
  }

  return { success: true, winning: true, currentBid: amount, endsAt: newEndsAt };
}

interface RecordBidParams {
  auctionId: string;
  bidderId: string;
  amount: number;
  isProxy: boolean;
  proxyMax: number | null;
  isWinning: boolean;
}

async function _recordBid({ auctionId, bidderId, amount, isProxy, proxyMax, isWinning }: RecordBidParams): Promise<void> {
  await supabaseAdmin.from("bids").insert({
    auction_id: auctionId,
    bidder_id: bidderId,
    amount,
    is_proxy: isProxy,
    proxy_max: proxyMax,
    is_winning: isWinning,
  });
}

// ── Close an auction ──────────────────────────────────────────────────────────

export async function closeAuction(auctionId: string): Promise<CloseAuctionResult> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*, users!photographer_id(stripe_account_id, email)")
    .eq("id", auctionId)
    .single();

  const a = auction as (DbAuction & { users?: Partial<DbUser> }) | null;
  if (!a || a.status !== "active") return { error: "Cannot close auction" };

  const { data: winningBid } = await supabaseAdmin
    .from("bids")
    .select("*, users!bidder_id(*)")
    .eq("auction_id", auctionId)
    .eq("is_winning", true)
    .single();
  const wb = winningBid as (DbBid & { users?: DbUser }) | null;

  if (!wb || wb.amount < a.reserve_price) {
    await supabaseAdmin.from("auctions").update({ status: "unsold" }).eq("id", auctionId);
    await _notifyAllBidders(auctionId, "unsold");
    return { success: true, sold: false };
  }

  const salePrice = wb.amount;
  const platformFee = parseFloat((salePrice * PLATFORM_FEE).toFixed(2));
  const photographerPayout = parseFloat((salePrice - platformFee).toFixed(2));

  await supabaseAdmin
    .from("auctions")
    .update({
      status: "sold",
      sale_price: salePrice,
      platform_fee: platformFee,
      photographer_payout: photographerPayout,
      buyer_id: wb.bidder_id,
      winning_bid_id: wb.id,
    })
    .eq("id", auctionId);

  const { data: tx } = await supabaseAdmin
    .from("transactions")
    .insert({
      auction_id: auctionId,
      buyer_id: wb.bidder_id,
      photographer_id: a.photographer_id,
      gross_amount: salePrice,
      platform_fee: platformFee,
      photographer_payout: photographerPayout,
    })
    .select()
    .single();

  await notifyAuctionWon({ bidderId: wb.bidder_id, auctionId, amount: salePrice });
  await _notifyAllBidders(auctionId, "lost", wb.bidder_id);

  return {
    success: true,
    sold: true,
    transactionId: (tx as { id: string } | null)?.id,
    salePrice,
    photographerPayout,
  };
}

async function _notifyAllBidders(
  auctionId: string,
  outcome: "lost" | "unsold",
  excludeBidderId: string | null = null,
): Promise<void> {
  const { data: bids } = await supabaseAdmin
    .from("bids")
    .select("bidder_id")
    .eq("auction_id", auctionId)
    .neq("bidder_id", excludeBidderId);
  const uniqueBidders = [
    ...new Set((bids as Array<{ bidder_id: string }> | null)?.map((b) => b.bidder_id) ?? []),
  ];
  for (const bidderId of uniqueBidders) {
    if (outcome === "lost") await notifyAuctionLost({ bidderId, auctionId });
  }
}

// ── Activate a pending auction ────────────────────────────────────────────────

export async function activateAuction(auctionId: string): Promise<ActivateAuctionResult> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", auctionId)
    .single();
  const a = auction as DbAuction | null;
  if (!a || a.status !== "pending") return { error: "Not a pending auction" };

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + a.duration_hours * 60 * 60 * 1000);

  await supabaseAdmin
    .from("auctions")
    .update({
      status: "active",
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .eq("id", auctionId);

  const { data: buyers } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("role", "buyer")
    .eq("verified", true);
  for (const buyer of (buyers as Array<{ id: string }>) || []) {
    await supabaseAdmin.from("notifications").insert({
      user_id: buyer.id,
      type: "new_listing",
      auction_id: auctionId,
      title: "📷 New Content Listed",
      body: `"${a.title}" is now live for bidding.`,
    });
  }

  return { success: true, startsAt, endsAt };
}

// ── Process all expired auctions (called by cron) ─────────────────────────────

export async function processExpiredAuctions(): Promise<Array<{ id: string } & CloseAuctionResult>> {
  const { data: expired } = await supabaseAdmin
    .from("auctions")
    .select("id")
    .eq("status", "active")
    .lt("ends_at", new Date().toISOString());

  const results: Array<{ id: string } & CloseAuctionResult> = [];
  for (const auction of (expired as Array<{ id: string }>) || []) {
    const result = await closeAuction(auction.id);
    results.push({ id: auction.id, ...result });
  }
  return results;
}
