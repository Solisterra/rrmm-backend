import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dir, "../.env") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Stripe enrichment (test mode only) ────────────────────────────────────────
// Without real test-mode Stripe objects the seeded world can't complete a
// checkout: purchase requires the buyer to hold a stripe_customer_id and the
// photographer a transfers-capable Connect account (the 409 payout gate).
// Guarded to sk_test_ so this can never touch live Stripe.
const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeKey.startsWith("sk_test_") ? new Stripe(stripeKey) : null;

// Fully-enabled test Connect account, no onboarding browser flow needed:
// Custom type + Stripe's test-mode magic values ("address_full_match",
// ssn_last_4 0000, test routing/account numbers) verify instantly, so
// destination charges to it succeed.
async function createTestConnectAccount(email, displayName) {
  const [first, ...rest] = displayName.split(" ");
  const account = await stripe.accounts.create({
    type: "custom",
    country: "US",
    email,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    individual: {
      first_name: first,
      last_name: rest.join(" ") || "Seed",
      email,
      phone: "+15555550100",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "address_full_match",
        city: "Brownsville",
        state: "TX",
        postal_code: "78520",
        country: "US",
      },
      ssn_last_4: "0000",
    },
    business_profile: {
      mcc: "7333",
      product_description: "Aerospace photography licensing (seed)",
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    external_account: {
      object: "bank_account",
      country: "US",
      currency: "usd",
      routing_number: "110000000",
      account_number: "000123456789",
    },
  });
  return account.id;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseFollowers(str) {
  if (typeof str === "number") return str;
  const s = String(str).trim().toUpperCase();
  if (s.endsWith("K")) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s, 10) || 0;
}

function minutesAgoToISO(timeStr) {
  const m = timeStr.match(/(\d+)m ago/);
  if (m) return new Date(Date.now() - +m[1] * 60_000).toISOString();
  return new Date().toISOString();
}

function approxDateToISO(label) {
  if (label === "Today") return new Date().toISOString();
  return new Date(`${label} 2026`).toISOString();
}

async function insert(table, rows, label) {
  const { data, error } = await db.from(table).insert(rows).select("id");
  if (error) {
    console.error(`  ERROR inserting ${label}:`, error.message);
    throw error;
  }
  console.log(`  + ${data.length} ${label}`);
  return data;
}

// ── seed data ─────────────────────────────────────────────────────────────────

const AUCTIONS = [
  {
    id: 1,
    title: "IFT-9 Booster Catch — Low Angle Sunrise",
    category: "Launch Event",
    photographer: "@boca_lens",
    emoji: "🚀",
    exclusive: "Full Exclusive",
    currentBid: 1250,
    minBid: 1350,
    bids: 7,
    minutesLeft: 94,
    hot: true,
    isNew: false,
    bidHistory: [
      { user: "NASASpaceflight", amount: 1250, time: "8m ago" },
      { user: "EverydayAstronaut", amount: 1100, time: "22m ago" },
      { user: "LabPadre", amount: 900, time: "41m ago" },
    ],
  },
  {
    id: 2,
    title: "Ship 35 Rollout — Pre-Dawn",
    category: "Infrastructure",
    photographer: "@starbase_shots",
    emoji: "🌙",
    exclusive: "Full Exclusive",
    currentBid: 380,
    minBid: 430,
    bids: 3,
    minutesLeft: 210,
    hot: false,
    isNew: false,
    bidHistory: [{ user: "SpaceExplored", amount: 380, time: "15m ago" }],
  },
  {
    id: 3,
    title: "Raptor Static Fire — Plume Detail 4K",
    category: "Test Event",
    photographer: "@rio_grande_media",
    emoji: "🔥",
    exclusive: "Full Exclusive",
    currentBid: 720,
    minBid: 820,
    bids: 5,
    minutesLeft: 28,
    hot: true,
    isNew: false,
    bidHistory: [
      { user: "EverydayAstronaut", amount: 720, time: "4m ago" },
      { user: "LabPadre", amount: 650, time: "11m ago" },
    ],
  },
  {
    id: 4,
    title: "Starbase Sunset — Mechazilla Silhouette",
    category: "Scenic",
    photographer: "@boca_chica_sky",
    emoji: "🌅",
    exclusive: "Non-Exclusive",
    currentBid: 95,
    minBid: 120,
    bids: 2,
    minutesLeft: 340,
    hot: false,
    isNew: true,
    bidHistory: [{ user: "SpaceExplored", amount: 95, time: "32m ago" }],
  },
  {
    id: 5,
    title: "Ship 36 Heat Shield Tile Install",
    category: "Infrastructure",
    photographer: "@starbase_shots",
    emoji: "🛡️",
    exclusive: "Full Exclusive",
    currentBid: 290,
    minBid: 340,
    bids: 2,
    minutesLeft: 180,
    hot: false,
    isNew: true,
    bidHistory: [{ user: "LabPadre", amount: 290, time: "28m ago" }],
  },
  {
    id: 6,
    title: "Anomaly — Cryo Test Pressure Event",
    category: "Breaking",
    photographer: "@boca_lens",
    emoji: "💥",
    exclusive: "Full Exclusive",
    currentBid: 1800,
    minBid: 2000,
    bids: 11,
    minutesLeft: 12,
    hot: true,
    isNew: false,
    bidHistory: [
      { user: "NASASpaceflight", amount: 1800, time: "2m ago" },
      { user: "EverydayAstronaut", amount: 1650, time: "5m ago" },
    ],
  },
];

// Marketplace listings — content that didn't sell at auction and moved to the
// fixed-price, non-exclusive Marketplace. `price` is the fallback price; `licensed`
// is how many buyers have licensed it ("N licensed" social proof). `daysListed`
// sets marketplace_since relative to now (drives the 30-day archive clock + "New").
const MARKETPLACE = [
  {
    title: "Starship Stack — Wide Establishing Shot",
    category: "Scenic",
    photographer: "@boca_chica_sky",
    emoji: "🌆",
    price: 75,
    reserve: 400,
    licensed: 42,
    daysListed: 12,
  },
  {
    title: "Mechazilla Arms — Detail Pack",
    category: "Infrastructure",
    photographer: "@starbase_shots",
    emoji: "🦾",
    price: 120,
    reserve: 500,
    licensed: 18,
    daysListed: 6,
  },
  {
    title: "Raptor Engine Bay — Editorial Set",
    category: "Test Event",
    photographer: "@rio_grande_media",
    emoji: "🔧",
    price: 95,
    reserve: 450,
    licensed: 7,
    daysListed: 2,
  },
  {
    title: "Launch Pad at Golden Hour",
    category: "Scenic",
    photographer: "@boca_lens",
    emoji: "🌇",
    price: 60,
    reserve: 300,
    licensed: 0,
    daysListed: 0,
  },
  {
    title: "Orbital Tank Farm — Aerial Survey",
    category: "Infrastructure",
    photographer: "@boca_chica_sky",
    emoji: "🛢️",
    price: 140,
    reserve: 600,
    licensed: 23,
    daysListed: 9,
  },
];

const EARNINGS_HIST = [
  {
    id: 1,
    title: "IFT-8 Launch Sequence",
    emoji: "🚀",
    category: "Launch Event",
    salePrice: 1400,
    net: 1120,
    buyer: "NASASpaceflight",
    photographer: "@boca_lens",
    date: "Apr 28",
    status: "paid",
  },
  {
    id: 2,
    title: "Starship Stack at Dusk",
    emoji: "🌆",
    category: "Scenic",
    salePrice: 320,
    net: 256,
    buyer: "EverydayAstronaut",
    photographer: "@boca_chica_sky",
    date: "Apr 24",
    status: "paid",
  },
  {
    id: 3,
    title: "Raptor Engine Test Series",
    emoji: "🔥",
    category: "Test Event",
    salePrice: 890,
    net: 712,
    buyer: "LabPadre",
    photographer: "@rio_grande_media",
    date: "Apr 19",
    status: "paid",
  },
  {
    id: 5,
    title: "Ship 34 Rollout",
    emoji: "🌙",
    category: "Infrastructure",
    salePrice: 480,
    net: 384,
    buyer: "SpaceExplored",
    photographer: "@starbase_shots",
    date: "Apr 12",
    status: "pending",
  },
];

const SAMPLE_APPS = [
  {
    name: "Marcus Webb",
    email: "marcus@orbitwatch.tv",
    channel: "OrbitWatch",
    note: "We cover every Starship flight live. Averaging 180K views per launch video.",
    platforms: [
      { name: "YouTube", followers: "220K" },
      { name: "Twitter/X", followers: "85K" },
    ],
    status: "pending",
  },
  {
    name: "Priya Nair",
    email: "priya@deepspacedigest.com",
    channel: "Deep Space Digest",
    note: "Weekly SpaceX roundup newsletter + YouTube. Exclusive content helps us differentiate.",
    platforms: [
      { name: "YouTube", followers: "67K" },
      { name: "Instagram", followers: "41K" },
    ],
    status: "pending",
  },
  {
    name: "Jake Torrence",
    email: "jake@starshipfan.net",
    channel: "StarshipFan",
    note: "Independent creator, 4 years covering Boca Chica. I publish fast after events.",
    platforms: [
      { name: "YouTube", followers: "310K" },
      { name: "Twitter/X", followers: "120K" },
    ],
    status: "pending",
  },
  {
    name: "Chen Media LLC",
    email: "ops@chenmediagroup.com",
    channel: "ChenSpace",
    note: "We manage three space-focused YouTube channels.",
    platforms: [
      { name: "YouTube", followers: "890K" },
      { name: "TikTok", followers: "340K" },
    ],
    status: "approved",
  },
  {
    name: "Rachel Kim",
    email: "rachel@launchlog.io",
    channel: "LaunchLog",
    note: "Data-driven space journalism. We pay fairly for exclusives.",
    platforms: [
      { name: "Twitter/X", followers: "52K" },
      { name: "Newsletter", followers: "28K" },
    ],
    status: "rejected",
  },
];

const SEED_EMAILS = [
  "boca_lens@example.com",
  "starbase_shots@example.com",
  "rio_grande_media@example.com",
  "boca_chica_sky@example.com",
  "nasaspaceflight@example.com",
  "everydayastronaut@example.com",
  "labpadre@example.com",
  "spaceexplored@example.com",
];

const APP_EMAILS = [
  "marcus@orbitwatch.tv",
  "priya@deepspacedigest.com",
  "jake@starshipfan.net",
  "ops@chenmediagroup.com",
  "rachel@launchlog.io",
];

// The handles this seed owns. We also clear by handle (not just email) so a
// re-run reclaims handles even if a prior run / test signup left a row behind
// under a different email — handle has a UNIQUE constraint and would otherwise
// collide on insert.
const SEED_HANDLES = [
  "@boca_lens",
  "@starbase_shots",
  "@rio_grande_media",
  "@boca_chica_sky",
  "NASASpaceflight",
  "EverydayAstronaut",
  "LabPadre",
  "SpaceExplored",
];

async function clear() {
  console.log("Clearing previous seed data...");

  // Look up seeded users by email OR handle (handle is UNIQUE, so a stray row
  // holding a seed handle under another email must be cleared too).
  const { data: byEmail } = await db
    .from("users")
    .select("id")
    .in("email", SEED_EMAILS);
  const { data: byHandle } = await db
    .from("users")
    .select("id")
    .in("handle", SEED_HANDLES);
  const seedIds = [
    ...new Set([...(byEmail || []), ...(byHandle || [])].map((u) => u.id)),
  ];

  if (seedIds.length > 0) {
    // Auctions created by or bought by seeded users
    const { data: seedAuctions } = await db
      .from("auctions")
      .select("id")
      .or(
        `photographer_id.in.(${seedIds.join(",")}),buyer_id.in.(${seedIds.join(",")})`,
      );
    const auctionIds = (seedAuctions || []).map((a) => a.id);

    if (auctionIds.length > 0) {
      await db.from("bids").delete().in("auction_id", auctionIds);
      // license_acceptances.transaction_id has no cascade — clear them before
      // their transactions so transaction deletes aren't blocked.
      await db
        .from("license_acceptances")
        .delete()
        .in("content_id", auctionIds);
      await db.from("transactions").delete().in("auction_id", auctionIds);
      await db.from("auctions").delete().in("id", auctionIds);
    }

    // Transactions can also reference seed users directly (buyer/photographer)
    // on non-seed auctions; remove those before deleting the users.
    await db
      .from("transactions")
      .delete()
      .or(
        `photographer_id.in.(${seedIds.join(",")}),buyer_id.in.(${seedIds.join(",")})`,
      );

    const { error: userDelErr } = await db
      .from("users")
      .delete()
      .in("id", seedIds);
    if (userDelErr)
      throw new Error(`clearing seed users: ${userDelErr.message}`);
  }

  await db.from("buyer_applications").delete().in("email", APP_EMAILS);

  console.log("  done\n");
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  await clear();
  console.log("Seeding RRMM database...\n");

  // 1. Users
  const photographerRows = [
    {
      email: "boca_lens@example.com",
      handle: "@boca_lens",
      display_name: "Boca Lens",
      role: "photographer",
      verified: true,
      sell_status: "verified",
    },
    {
      email: "starbase_shots@example.com",
      handle: "@starbase_shots",
      display_name: "Starbase Shots",
      role: "photographer",
      verified: true,
      sell_status: "verified",
    },
    {
      email: "rio_grande_media@example.com",
      handle: "@rio_grande_media",
      display_name: "Rio Grande Media",
      role: "photographer",
      verified: true,
      sell_status: "verified",
    },
    {
      email: "boca_chica_sky@example.com",
      handle: "@boca_chica_sky",
      display_name: "Boca Chica Sky",
      role: "photographer",
      verified: true,
      sell_status: "verified",
    },
  ];

  // Verified-tier bidders (can bid AND buy) — except SpaceExplored, which stays
  // in the self-service marketplace tier to exercise the bid-rejection path.
  const buyerRows = [
    {
      email: "nasaspaceflight@example.com",
      handle: "NASASpaceflight",
      display_name: "NASASpaceflight",
      role: "buyer",
      verified: true,
      buyer_tier: "verified",
      bid_status: "verified",
      follower_count: 3_000_000,
    },
    {
      email: "everydayastronaut@example.com",
      handle: "EverydayAstronaut",
      display_name: "Everyday Astronaut",
      role: "buyer",
      verified: true,
      buyer_tier: "verified",
      bid_status: "verified",
      follower_count: 1_200_000,
    },
    {
      email: "labpadre@example.com",
      handle: "LabPadre",
      display_name: "LabPadre",
      role: "buyer",
      verified: true,
      buyer_tier: "verified",
      bid_status: "verified",
      follower_count: 500_000,
    },
    {
      email: "spaceexplored@example.com",
      handle: "SpaceExplored",
      display_name: "SpaceExplored",
      role: "buyer",
      verified: true,
      buyer_tier: "marketplace",
      bid_status: "none",
      follower_count: 250_000,
    },
  ];

  // Real test-mode Stripe objects so checkout works end-to-end. Photographers
  // get transfers-capable Connect accounts (passes the purchase 409 gate and
  // receives the 80% destination charge); buyers get bare Customers (Checkout
  // collects the card at pay time — use 4242 4242 4242 4242).
  if (stripe) {
    console.log("  creating test-mode Stripe accounts/customers...");
    // Connect accounts need Connect enabled on the platform (one-time, at
    // dashboard.stripe.com/connect). Until then, seed everything else and warn:
    // purchases will stop at the 409 payout-onboarding gate by design.
    try {
      for (const p of photographerRows) {
        p.stripe_account_id = await createTestConnectAccount(
          p.email,
          p.display_name,
        );
        p.stripe_account_status = "active";
      }
    } catch (err) {
      console.warn(
        `  ! Connect accounts skipped: ${err.message}\n` +
          "    Enable Connect (test mode) at https://dashboard.stripe.com/connect, then re-run the seed to make checkout fully testable.",
      );
    }
    for (const b of buyerRows) {
      const customer = await stripe.customers.create({
        email: b.email,
        name: b.display_name,
        description: "RRMM seed buyer",
      });
      b.stripe_customer_id = customer.id;
    }
  } else {
    console.log(
      "  (no sk_test_ STRIPE_SECRET_KEY — seeding without Stripe; checkout will stop at the payment-method/onboarding gates)",
    );
  }

  const { data: photographers, error: pErr } = await db
    .from("users")
    .insert(photographerRows)
    .select("id, handle");
  if (pErr) throw new Error(`photographers: ${pErr.message}`);
  console.log(`  + ${photographers.length} photographers`);

  const { data: buyerUsers, error: bErr } = await db
    .from("users")
    .insert(buyerRows)
    .select("id, handle");
  if (bErr) throw new Error(`buyers: ${bErr.message}`);
  console.log(`  + ${buyerUsers.length} buyers`);

  const byHandle = {};
  [...photographers, ...buyerUsers].forEach((u) => {
    byHandle[u.handle] = u.id;
  });

  // 2. Active auctions
  const now = Date.now();
  const activeAuctionRows = AUCTIONS.map((a) => ({
    photographer_id: byHandle[a.photographer],
    title: a.title,
    description: `${a.emoji} ${a.title}`,
    category: a.category,
    content_type: "photo",
    exclusivity: a.exclusive,
    preview_url: `https://placehold.co/800x600?text=${encodeURIComponent(a.title)}`,
    status: "active",
    reserve_price: a.minBid,
    current_bid: a.currentBid,
    bid_count: a.bids,
    duration_hours: 4,
    is_featured: a.hot,
    // Use 7-day windows in dev so auctions don't expire before you're done testing
    starts_at: new Date(now - (4 * 60 - a.minutesLeft) * 60_000).toISOString(),
    ends_at: new Date(
      now + 7 * 24 * 60 * 60_000 + a.minutesLeft * 60_000,
    ).toISOString(),
  }));

  const { data: activeAuctions, error: aaErr } = await db
    .from("auctions")
    .insert(activeAuctionRows)
    .select("id, title");
  if (aaErr) throw new Error(`active auctions: ${aaErr.message}`);
  console.log(`  + ${activeAuctions.length} active auctions`);

  const auctionByTitle = {};
  activeAuctions.forEach((a) => {
    auctionByTitle[a.title] = a.id;
  });

  // 3. Bids for active auctions
  const bidRows = [];
  AUCTIONS.forEach((a) => {
    a.bidHistory.forEach((b, idx) => {
      bidRows.push({
        auction_id: auctionByTitle[a.title],
        bidder_id: byHandle[b.user],
        amount: b.amount,
        is_winning: idx === 0,
        created_at: minutesAgoToISO(b.time),
      });
    });
  });

  await insert("bids", bidRows, "bids");

  // 3b. Marketplace listings (auction → marketplace lifecycle stage)
  const marketplaceRows = MARKETPLACE.map((m) => {
    const since = new Date(now - m.daysListed * 24 * 60 * 60_000).toISOString();
    // The auction ran for its duration and closed (unsold) right before it
    // entered the marketplace.
    const startedAt = new Date(
      now - (m.daysListed * 24 + 4) * 60 * 60_000,
    ).toISOString();
    return {
      photographer_id: byHandle[m.photographer],
      title: m.title,
      description: `${m.emoji} ${m.title}`,
      category: m.category,
      content_type: "photo",
      exclusivity: "Non-Exclusive",
      preview_url: `https://placehold.co/800x600?text=${encodeURIComponent(m.title)}`,
      status: "marketplace",
      reserve_price: m.reserve,
      fallback_price: m.price,
      license_count: m.licensed,
      marketplace_since: since,
      duration_hours: 4,
      starts_at: startedAt,
      ends_at: since,
      created_at: startedAt,
    };
  });

  const { data: marketplaceListings, error: mErr } = await db
    .from("auctions")
    .insert(marketplaceRows)
    .select("id, title");
  if (mErr) throw new Error(`marketplace listings: ${mErr.message}`);
  console.log(`  + ${marketplaceListings.length} marketplace listings`);

  // 3c. Archived listing — sat 30+ days on the marketplace with zero licenses,
  // swept by the archive cron; rights reverted. Feeds the photographer's
  // archived dashboard (GET /api/users/archived) and the relist flow.
  const archivedSince = new Date(now - 40 * 24 * 60 * 60_000).toISOString();
  const archivedRows = [
    {
      photographer_id: byHandle["@boca_lens"],
      title: "Static Fire Smoke Rings — Detail Study",
      description: "💨 Static Fire Smoke Rings — Detail Study",
      category: "Test Event",
      content_type: "photo",
      exclusivity: "Non-Exclusive",
      preview_url: `https://placehold.co/800x600?text=${encodeURIComponent("Static Fire Smoke Rings")}`,
      status: "archived",
      reserve_price: 350,
      fallback_price: 80,
      license_count: 0,
      marketplace_since: archivedSince,
      rights_transferred: false,
      duration_hours: 4,
      starts_at: new Date(now - (40 * 24 + 4) * 60 * 60_000).toISOString(),
      ends_at: archivedSince,
      created_at: new Date(now - (40 * 24 + 4) * 60 * 60_000).toISOString(),
    },
  ];
  await insert("auctions", archivedRows, "archived listing");

  // 4. Historical sold auctions
  const histAuctionRows = EARNINGS_HIST.map((e) => {
    const soldAt = approxDateToISO(e.date);
    return {
      photographer_id: byHandle[e.photographer],
      buyer_id: byHandle[e.buyer],
      title: e.title,
      description: `${e.emoji} ${e.title}`,
      category: e.category,
      content_type: "photo",
      exclusivity: "Full Exclusive",
      preview_url: `https://placehold.co/800x600?text=${encodeURIComponent(e.title)}`,
      status: "sold",
      reserve_price: e.salePrice,
      current_bid: e.salePrice,
      sale_price: e.salePrice,
      platform_fee: e.salePrice - e.net,
      photographer_payout: e.net,
      bid_count: 1,
      duration_hours: 4,
      starts_at: soldAt,
      ends_at: soldAt,
      created_at: soldAt,
    };
  });

  const { data: histAuctions, error: haErr } = await db
    .from("auctions")
    .insert(histAuctionRows)
    .select("id, title");
  if (haErr) throw new Error(`historical auctions: ${haErr.message}`);
  console.log(`  + ${histAuctions.length} historical auctions`);

  const histByTitle = {};
  histAuctions.forEach((a) => {
    histByTitle[a.title] = a.id;
  });

  // 5. Transactions
  const txRows = EARNINGS_HIST.map((e) => ({
    auction_id: histByTitle[e.title],
    buyer_id: byHandle[e.buyer],
    photographer_id: byHandle[e.photographer],
    gross_amount: e.salePrice,
    platform_fee: e.salePrice - e.net,
    photographer_payout: e.net,
    payment_status: e.status === "paid" ? "succeeded" : "pending",
    payout_status: e.status === "paid" ? "paid" : "pending",
    payout_completed_at: e.status === "paid" ? approxDateToISO(e.date) : null,
    created_at: approxDateToISO(e.date),
  }));

  await insert("transactions", txRows, "transactions");

  // 6. Buyer applications
  const appRows = SAMPLE_APPS.map((a) => ({
    name: a.name,
    email: a.email,
    channel_name: a.channel,
    note: a.note,
    platforms: a.platforms.map((p) => ({
      name: p.name,
      followers: parseFollowers(p.followers),
    })),
    status: a.status,
  }));

  const { error: appErr } = await db.from("buyer_applications").insert(appRows);
  if (appErr) throw new Error(`buyer applications: ${appErr.message}`);
  console.log(`  + ${appRows.length} buyer applications`);

  console.log("\nSeed complete.");
}

run().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
