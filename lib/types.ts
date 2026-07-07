import type { NextApiRequest, NextApiResponse } from "next";

// ── Enum-like string unions ───────────────────────────────────────────────────

export type Role = "photographer" | "buyer" | "admin";
export type AuctionStatus =
  | "pending"
  | "active"
  | "closing"
  | "sold"
  | "unsold"
  | "cancelled"
  | "marketplace"
  | "archived";
// Self-service marketplace tier vs full verify-to-bid auction buyer.
export type BuyerTier = "marketplace" | "verified";
export type AuctionCategory =
  | "Launch Event"
  | "Test Event"
  | "Infrastructure"
  | "Breaking"
  | "Scenic"
  | "Milestone";
export type ContentType = "photo" | "video" | "drone" | "raw";
export type Exclusivity =
  | "Full Exclusive"
  | "Platform Exclusive"
  | "Non-Exclusive";
export type NotificationType =
  | "new_listing"
  | "outbid"
  | "auction_won"
  | "auction_lost"
  | "auction_sold"
  | "payment_received"
  | "payout_sent"
  | "auction_ending"
  | "content_approved"
  | "content_rejected"
  | "content_archived";
export type PaymentStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "refunded";
export type PayoutStatus = "pending" | "in_transit" | "paid" | "failed";
export type ApplicationStatus = "pending" | "approved" | "rejected";
export type CapabilityStatus = "none" | "pending" | "verified" | "rejected";
export type ContentDecision = "approved" | "rejected" | "flagged";
export type StripeAccountStatus =
  | "pending"
  | "pending_onboarding"
  | "active"
  | "restricted"
  | "n/a";

// ── DB row shapes ─────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  auth_id: string | null;
  email: string;
  handle: string | null;
  display_name: string | null;
  phone: string | null;
  role: Role;
  verified: boolean;
  buyer_tier: BuyerTier;
  bid_status: CapabilityStatus;
  sell_status: CapabilityStatus;
  follower_count: number;
  avatar_url: string | null;
  bio: string | null;
  portfolio_url: string | null;
  stripe_customer_id: string | null;
  stripe_account_id: string | null;
  stripe_account_status: StripeAccountStatus;
  payout_email: string | null;
  total_earned: number;
  total_spent: number;
  total_sales: number;
  total_wins: number;
  created_at: string;
  updated_at: string;
}

export interface DbAuction {
  id: string;
  photographer_id: string;
  title: string;
  description: string | null;
  category: AuctionCategory;
  content_type: ContentType;
  exclusivity: Exclusivity;
  preview_url: string;
  watermark_url: string | null;
  full_url: string | null;
  file_size_mb: number | null;
  duration_secs: number | null;
  status: AuctionStatus;
  reserve_price: number;
  fallback_price: number | null;
  marketplace_since: string | null;
  license_count: number;
  duration_hours: number;
  starts_at: string | null;
  ends_at: string | null;
  auto_extended: boolean;
  extension_count: number;
  current_bid: number;
  bid_count: number;
  winning_bid_id: string | null;
  buyer_id: string | null;
  sale_price: number | null;
  platform_fee: number | null;
  photographer_payout: number | null;
  rights_transferred: boolean;
  contract_url: string | null;
  contract_signed_at: string | null;
  event_tag: string | null;
  is_featured: boolean;
  view_count: number;
  created_at: string;
  updated_at: string;
  // Optional joined fields
  users?: Partial<DbUser>;
  bids?: DbBid[];
}

export interface DbBid {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: number;
  is_proxy: boolean;
  proxy_max: number | null;
  is_winning: boolean;
  outbid_at: string | null;
  outbid_notified: boolean;
  created_at: string;
  users?: Partial<DbUser>;
}

export interface DbTransaction {
  id: string;
  auction_id: string;
  buyer_id: string;
  photographer_id: string;
  gross_amount: number;
  platform_fee: number;
  photographer_payout: number;
  stripe_fee: number | null;
  payment_intent_id: string | null;
  payment_status: PaymentStatus;
  charge_id: string | null;
  payout_id: string | null;
  payout_status: PayoutStatus;
  payout_initiated_at: string | null;
  payout_completed_at: string | null;
  created_at: string;
  updated_at: string;
  auctions?: Partial<DbAuction>;
  buyer?: Partial<DbUser>;
}

// Immutable, audited record of a buyer accepting the non-exclusive license at
// purchase. Many per content (one per marketplace sale) — links to transaction_id;
// there is intentionally no back-reference column on auctions. Cloned from the
// attestations pattern. See supabase/content_lifecycle_migration.sql.
export interface DbLicenseAcceptance {
  id: string;
  buyer_id: string;
  content_id: string;
  transaction_id: string;
  agreement_accepted: boolean;
  accepted_at: string;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  license_version: string;
  legal_text_snapshot: string;
}

export interface PlatformEntry {
  name: string;
  url?: string;
  followers: number;
}

export interface DbBuyerApplication {
  id: string;
  name: string;
  email: string;
  channel_name: string;
  content_focus: string | null;
  note: string | null;
  platforms: PlatformEntry[];
  total_followers: number;
  status: ApplicationStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  invite_token: string | null;
  invite_sent_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbNotification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  auction_id: string | null;
  read: boolean;
  sent_sms: boolean;
  sent_email: boolean;
  created_at: string;
}

// ── API helpers ───────────────────────────────────────────────────────────────

export type ApiHandler<T = unknown> = (
  req: NextApiRequest,
  res: NextApiResponse<T | { error: string; requestId?: string }>,
) => Promise<void>;

export interface PlaceBidParams {
  auctionId: string;
  bidderId: string;
  amount: number;
  proxyMax?: number | null;
}

export interface PlaceBidResult {
  success?: boolean;
  winning?: boolean;
  currentBid?: number;
  endsAt?: string;
  message?: string;
  error?: string;
}

export interface CloseAuctionResult {
  success?: boolean;
  sold?: boolean;
  marketplace?: boolean;
  transactionId?: string;
  salePrice?: number;
  photographerPayout?: number;
  error?: string;
}

export interface ActivateAuctionResult {
  success?: boolean;
  startsAt?: Date;
  endsAt?: Date;
  error?: string;
}

// Relist an archived listing (B9). `auction` starts a fresh auction (needs a
// reserve + duration, optional fallback price); `marketplace` puts it straight
// back up at a fixed price (needs fallbackPrice).
export interface RelistListingParams {
  auctionId: string;
  mode: "auction" | "marketplace";
  reservePrice?: number; // required for auction mode
  durationHours?: number; // required for auction mode
  fallbackPrice?: number | null; // required for marketplace mode; optional for auction
}

export interface RelistListingResult {
  success?: boolean;
  status?: AuctionStatus; // the new listing status on success
  startsAt?: string; // auction mode only
  endsAt?: string; // auction mode only
  error?: string;
}

// Result of the archive sweep on a single stale marketplace listing.
// `archived` is false when the race-guarded conditional UPDATE matched no row —
// an in-flight purchase bumped license_count, or the listing was already archived.
export interface ArchiveListingResult {
  success?: boolean;
  archived: boolean;
  error?: string;
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

export interface CreatePaymentIntentParams {
  amount: number;
  buyerStripeId: string;
  auctionId: string;
  photographerAccountId: string;
}

export interface CreateCheckoutSessionParams {
  amount: number;
  buyerStripeId: string;
  // The content/listing id — kept on the PaymentIntent for context and as a
  // legacy fallback. Settlement keys off `transactionId`, not this.
  auctionId: string;
  // The transaction row the webhook settles by id. Required for the unified
  // settlement path: a marketplace listing has MANY transactions, so keying off
  // auctionId would settle the wrong rows. Present for both auction and
  // marketplace checkouts.
  transactionId?: string;
  // 'auction' = exclusive, one-off, listing becomes terminal (sold).
  // 'marketplace' = non-exclusive, listing stays live, per-buyer delivery.
  purchaseType?: "auction" | "marketplace";
  title: string;
  // When present, use a destination charge: take our fee and pay the
  // photographer's net automatically. When absent, the platform collects and
  // payout is reconciled separately.
  photographerAccountId?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface InitiatePayoutParams {
  photographerAccountId: string;
  amount: number;
  auctionId: string;
}

// ── Notification helpers ──────────────────────────────────────────────────────

export interface NotifyOutbidParams {
  bidderId: string;
  auctionId: string;
  newBid: number;
}

export interface NotifyAuctionWonParams {
  bidderId: string;
  auctionId: string;
  amount: number;
}

export interface NotifyAuctionLostParams {
  bidderId: string;
  auctionId: string;
}

// Seller-facing: their listing sold (sent at close, before buyer payment).
export interface NotifyAuctionSoldParams {
  photographerId: string;
  auctionId: string;
  amount: number;
}

export interface NotifyPaymentReceivedParams {
  photographerId: string;
  auctionId: string;
  amount: number;
}

export interface NotifyWatchlistUrgentParams {
  auctionId: string;
  minutesLeft: number;
}

export interface NotifyContentParams {
  photographerId: string;
  auctionId: string;
  reason?: string;
  // Approval of a direct-to-marketplace listing (fixed price, no auction) —
  // switches the approved-notification copy.
  marketplace?: boolean;
}

// Seller-facing: their stale marketplace listing was archived (30d, no licenses).
export interface NotifyContentArchivedParams {
  photographerId: string;
  auctionId: string;
}

// ── DocuSign ──────────────────────────────────────────────────────────────────

export interface RightsTransferParams {
  transactionId: string;
  buyerEmail: string;
  buyerName: string;
  photographerEmail: string;
  photographerName?: string;
  listingTitle: string;
  salePrice: number;
  exclusiveTier: string;
}

// ── Format helpers ────────────────────────────────────────────────────────────

export interface FormattedAuction {
  id: string;
  photographer_id: string;
  title: string;
  category: AuctionCategory;
  photographer: string;
  emoji: string;
  exclusive: Exclusivity;
  currentBid: number;
  minBid: number;
  bids: number;
  minutesLeft: number;
  bidHistory: unknown[];
  hot: boolean;
  isNew: boolean;
  preview_url: string | null;
  watermark_url: string | null;
  full_url: string | null;
  event_tag: string | null;
}

// A marketplace listing as the frontend consumes it. Marketplace listings are
// auctions with status='marketplace': fixed-price (fallback_price), non-exclusive,
// licensable many times (license_count drives the "N licensed" social proof).
export interface FormattedMarketItem {
  id: string;
  photographer_id: string;
  title: string;
  category: AuctionCategory;
  photographer: string;
  emoji: string;
  exclusive: Exclusivity;
  price: number;
  licensed: number;
  preview_url: string | null;
  watermark_url: string | null;
  isNew: boolean;
}

// A photographer's own archived listing (30-day stale marketplace content whose
// rights reverted, B3) — the relist candidate the seller dashboard renders.
export interface FormattedArchivedListing {
  id: string;
  photographer_id: string;
  title: string;
  category: AuctionCategory;
  emoji: string;
  exclusive: Exclusivity;
  price: number;
  preview_url: string | null;
  watermark_url: string | null;
  archivedAt: string;
}

export interface FormattedApplication {
  id: string;
  name: string;
  email: string;
  channel: string;
  note: string;
  platforms: PlatformEntry[];
  appliedAt: string;
  status: ApplicationStatus;
}

export interface FormattedTransaction {
  id: string;
  title: string;
  emoji: string;
  category: string | null;
  buyer: string;
  date: string;
  status: "paid" | "pending";
  salePrice: number;
  net: number;
}
