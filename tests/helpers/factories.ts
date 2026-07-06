import type {
  DbAuction,
  DbUser,
  DbBid,
  DbTransaction,
  DbBuyerApplication,
} from "../../lib/types";

// Row factories: sensible defaults, override what a test cares about. They keep
// tests readable and shielded from unrelated schema fields.

export function makeUser(overrides: Partial<DbUser> = {}): DbUser {
  const now = new Date().toISOString();
  return {
    id: "user-1",
    auth_id: "auth-1",
    email: "buyer@example.com",
    handle: "buyer",
    display_name: "Buyer One",
    phone: null,
    role: "buyer",
    verified: true,
    buyer_tier: "marketplace",
    bid_status: "none",
    sell_status: "none",
    follower_count: 0,
    avatar_url: null,
    bio: null,
    portfolio_url: null,
    stripe_customer_id: "cus_123",
    stripe_account_id: null,
    stripe_account_status: "n/a",
    payout_email: null,
    total_earned: 0,
    total_spent: 0,
    total_sales: 0,
    total_wins: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function makeAuction(overrides: Partial<DbAuction> = {}): DbAuction {
  const now = new Date().toISOString();
  return {
    id: "auction-1",
    photographer_id: "photographer-1",
    title: "Starship Launch",
    description: null,
    category: "Launch Event",
    content_type: "photo",
    exclusivity: "Full Exclusive",
    preview_url: "https://preview",
    watermark_url: null,
    full_url: "photographer-1/file-1.jpg",
    file_size_mb: 12,
    duration_secs: null,
    status: "active",
    reserve_price: 1000,
    fallback_price: null,
    marketplace_since: null,
    license_count: 0,
    duration_hours: 24,
    starts_at: now,
    ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    auto_extended: false,
    extension_count: 0,
    current_bid: 0,
    bid_count: 0,
    winning_bid_id: null,
    buyer_id: null,
    sale_price: null,
    platform_fee: null,
    photographer_payout: null,
    rights_transferred: false,
    contract_url: null,
    contract_signed_at: null,
    event_tag: null,
    is_featured: false,
    view_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function makeBid(overrides: Partial<DbBid> = {}): DbBid {
  return {
    id: "bid-1",
    auction_id: "auction-1",
    bidder_id: "user-1",
    amount: 1500,
    is_proxy: false,
    proxy_max: null,
    is_winning: true,
    outbid_at: null,
    outbid_notified: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makeTransaction(
  overrides: Partial<DbTransaction> = {},
): DbTransaction {
  const now = new Date().toISOString();
  return {
    id: "tx-1",
    auction_id: "auction-1",
    buyer_id: "user-1",
    photographer_id: "photographer-1",
    gross_amount: 1500,
    platform_fee: 300,
    photographer_payout: 1200,
    stripe_fee: null,
    payment_intent_id: null,
    payment_status: "pending",
    charge_id: null,
    payout_id: null,
    payout_status: "pending",
    payout_initiated_at: null,
    payout_completed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function makeApplication(
  overrides: Partial<DbBuyerApplication> = {},
): DbBuyerApplication {
  const now = new Date().toISOString();
  return {
    id: "app-1",
    name: "Jane Buyer",
    email: "jane@example.com",
    channel_name: "Jane's Space Channel",
    content_focus: "rockets",
    note: "Big fan",
    platforms: [{ name: "YouTube", followers: 60000 }],
    total_followers: 60000,
    status: "pending",
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    invite_token: null,
    invite_sent_at: null,
    ip_address: null,
    user_agent: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
