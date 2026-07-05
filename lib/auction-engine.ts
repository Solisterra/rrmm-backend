import { supabaseAdmin } from "./supabase";
import { computeSplit } from "./money";
import {
  notifyOutbid,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyAuctionSold,
  notifyWatchlistUrgent,
  notifyContentArchived,
} from "./notifications";
import type {
  PlaceBidParams,
  PlaceBidResult,
  CloseAuctionResult,
  ActivateAuctionResult,
  ArchiveListingResult,
  RelistListingParams,
  RelistListingResult,
  DbAuction,
  DbBid,
  DbUser,
} from "./types";

const AUTO_EXTEND_MINUTES = 5;
const AUTO_EXTEND_TRIGGER_MINUTES = 5;
const MAX_EXTENSIONS = 6;
// A marketplace listing with no licenses sold is archived after this long.
const ARCHIVE_AFTER_DAYS = 30;

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
    a.current_bid > 0 ? Math.ceil(a.current_bid * 1.05) : a.reserve_price;
  if (amount < minBid) return { error: `Bid must be at least $${minBid}` };
  if (bidderId === a.photographer_id)
    return { error: "You cannot bid on your own listing." };

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
    await _recordBid({
      auctionId,
      bidderId: winner.bidder_id,
      amount: counterBid,
      isProxy: true,
      proxyMax: winner.proxy_max,
      isWinning: true,
    });
    await _recordBid({
      auctionId,
      bidderId,
      amount,
      isProxy: false,
      proxyMax: null,
      isWinning: false,
    });
    await supabaseAdmin
      .from("auctions")
      .update({ current_bid: counterBid, bid_count: a.bid_count + 2 })
      .eq("id", auctionId);
    await notifyOutbid({ bidderId, auctionId, newBid: counterBid });
    return {
      success: true,
      winning: false,
      currentBid: counterBid,
      message: "Outbid by proxy",
    };
  }

  if (winner) {
    await supabaseAdmin
      .from("bids")
      .update({ is_winning: false, outbid_at: new Date().toISOString() })
      .eq("id", winner.id);
    await notifyOutbid({
      bidderId: winner.bidder_id,
      auctionId,
      newBid: amount,
    });
  }

  await _recordBid({
    auctionId,
    bidderId,
    amount,
    isProxy: !!proxyMax,
    proxyMax,
    isWinning: true,
  });

  const endsAt = new Date(a.ends_at!);
  const now = new Date();
  const minutesLeft = (endsAt.getTime() - now.getTime()) / 60000;
  let newEndsAt = a.ends_at!;

  if (
    minutesLeft <= AUTO_EXTEND_TRIGGER_MINUTES &&
    a.extension_count < MAX_EXTENSIONS
  ) {
    newEndsAt = new Date(
      endsAt.getTime() + AUTO_EXTEND_MINUTES * 60 * 1000,
    ).toISOString();
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
    await notifyWatchlistUrgent({
      auctionId,
      minutesLeft: Math.round(minutesLeft),
    });
  }

  return {
    success: true,
    winning: true,
    currentBid: amount,
    endsAt: newEndsAt,
  };
}

interface RecordBidParams {
  auctionId: string;
  bidderId: string;
  amount: number;
  isProxy: boolean;
  proxyMax: number | null;
  isWinning: boolean;
}

async function _recordBid({
  auctionId,
  bidderId,
  amount,
  isProxy,
  proxyMax,
  isWinning,
}: RecordBidParams): Promise<void> {
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

export async function closeAuction(
  auctionId: string,
): Promise<CloseAuctionResult> {
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
    // No winning bid (or reserve not met). If a fallback price was set, move the
    // listing into the fixed-price marketplace; otherwise mark it unsold.
    if (a.fallback_price != null) {
      await supabaseAdmin
        .from("auctions")
        .update({
          status: "marketplace",
          marketplace_since: new Date().toISOString(),
        })
        .eq("id", auctionId);
      await _notifyAllBidders(auctionId, "unsold");
      return { success: true, sold: false, marketplace: true };
    }
    await supabaseAdmin
      .from("auctions")
      .update({ status: "unsold" })
      .eq("id", auctionId);
    await _notifyAllBidders(auctionId, "unsold");
    return { success: true, sold: false };
  }

  const salePrice = wb.amount;
  const { platformFee, photographerPayout } = computeSplit(salePrice);

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

  await notifyAuctionWon({
    bidderId: wb.bidder_id,
    auctionId,
    amount: salePrice,
  });
  await notifyAuctionSold({
    photographerId: a.photographer_id,
    auctionId,
    amount: salePrice,
  });
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
    ...new Set(
      (bids as Array<{ bidder_id: string }> | null)?.map((b) => b.bidder_id) ??
        [],
    ),
  ];
  for (const bidderId of uniqueBidders) {
    if (outcome === "lost") await notifyAuctionLost({ bidderId, auctionId });
  }
}

// ── Activate a pending auction ────────────────────────────────────────────────

export async function activateAuction(
  auctionId: string,
): Promise<ActivateAuctionResult> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("*")
    .eq("id", auctionId)
    .single();
  const a = auction as DbAuction | null;
  if (!a || a.status !== "pending") return { error: "Not a pending auction" };

  const startsAt = new Date();
  const endsAt = new Date(
    startsAt.getTime() + a.duration_hours * 60 * 60 * 1000,
  );

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

export async function processExpiredAuctions(): Promise<
  Array<{ id: string } & CloseAuctionResult>
> {
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

// ── Archive a stale marketplace listing ───────────────────────────────────────

export async function archiveListing(
  auctionId: string,
): Promise<ArchiveListingResult> {
  // Race-safe flip: re-assert status='marketplace' AND license_count=0 in the
  // WHERE, not just in the caller's pre-select. The select and update are not
  // atomic, so a purchase that lands inside the 30-day window (and bumps
  // license_count on payment success — see the webhook) must make this UPDATE
  // match zero rows so the listing correctly stays live. Same predicate makes
  // re-runs idempotent: once archived, status is no longer 'marketplace'.
  const { data: archived } = await supabaseAdmin
    .from("auctions")
    .update({
      status: "archived",
      // Rights revert to the photographer. No license was ever sold
      // (license_count=0), so the content leaves the marketplace with no buyer
      // holding any rights — this makes that explicit and survives re-runs.
      rights_transferred: false,
    })
    .eq("id", auctionId)
    .eq("status", "marketplace")
    .eq("license_count", 0)
    .select("id, photographer_id, title");

  const rows = archived as Array<
    Pick<DbAuction, "id" | "photographer_id" | "title">
  > | null;
  // Zero rows ⇒ lost the race to an in-flight purchase, or already archived.
  if (!rows || rows.length === 0) return { archived: false };

  await notifyContentArchived({
    photographerId: rows[0].photographer_id,
    auctionId,
  });
  return { success: true, archived: true };
}

// ── Process stale marketplace listings (called by cron) ───────────────────────
// Second, independent sweep alongside processExpiredAuctions in the same cron run.
// Marketplace listings that sit 30 days with no license sold are archived and
// their rights revert to the photographer.
export async function processStaleMarketplaceListings(): Promise<
  Array<{ id: string } & ArchiveListingResult>
> {
  const cutoff = new Date(
    Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Candidate pre-filter; archiveListing re-checks the same predicate atomically.
  // marketplace_since is always set on entry to 'marketplace' (see closeAuction);
  // a NULL would be excluded by `<`, which is the safe default.
  const { data: stale } = await supabaseAdmin
    .from("auctions")
    .select("id")
    .eq("status", "marketplace")
    .eq("license_count", 0)
    .lt("marketplace_since", cutoff);

  const results: Array<{ id: string } & ArchiveListingResult> = [];
  for (const listing of (stale as Array<{ id: string }>) || []) {
    const result = await archiveListing(listing.id);
    results.push({ id: listing.id, ...result });
  }
  return results;
}

// ── Relist an archived listing ────────────────────────────────────────────────
// The photographer puts previously-archived content back up for sale, either as a
// fresh auction or straight into the fixed-price marketplace. Ownership/role are
// enforced by the route; this owns the state transition. The flip is a CONDITIONAL
// UPDATE re-asserting `status='archived'` in the WHERE, so a concurrent relist (or
// any non-archived state) matches zero rows and returns an error instead of
// silently re-arming a live listing.
export async function relistListing({
  auctionId,
  mode,
  reservePrice,
  durationHours,
  fallbackPrice = null,
}: RelistListingParams): Promise<RelistListingResult> {
  if (mode === "auction") {
    const startsAt = new Date();
    const endsAt = new Date(
      startsAt.getTime() + durationHours! * 60 * 60 * 1000,
    );
    // Reset every auction + prior-sale field so the relisted auction starts clean;
    // clear the marketplace clock since it's no longer a marketplace item.
    const { data } = await supabaseAdmin
      .from("auctions")
      .update({
        status: "active",
        reserve_price: reservePrice,
        duration_hours: durationHours,
        fallback_price: fallbackPrice,
        marketplace_since: null,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        current_bid: 0,
        bid_count: 0,
        winning_bid_id: null,
        buyer_id: null,
        sale_price: null,
        platform_fee: null,
        photographer_payout: null,
        auto_extended: false,
        extension_count: 0,
        rights_transferred: false,
      })
      .eq("id", auctionId)
      .eq("status", "archived")
      .select("id");

    const rows = data as Array<{ id: string }> | null;
    if (!rows || rows.length === 0)
      return { error: "Listing is not archived" };
    return {
      success: true,
      status: "active",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
  }

  // marketplace mode: fixed-price, non-exclusive. Restart the 30-day archive clock.
  // license_count is already 0 (the archive gate), so it needs no reset.
  const { data } = await supabaseAdmin
    .from("auctions")
    .update({
      status: "marketplace",
      fallback_price: fallbackPrice,
      marketplace_since: new Date().toISOString(),
      rights_transferred: false,
    })
    .eq("id", auctionId)
    .eq("status", "archived")
    .select("id");

  const rows = data as Array<{ id: string }> | null;
  if (!rows || rows.length === 0) return { error: "Listing is not archived" };
  return { success: true, status: "marketplace" };
}
