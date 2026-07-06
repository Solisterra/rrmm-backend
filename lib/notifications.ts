import { supabaseAdmin } from "./supabase";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import type {
  NotifyOutbidParams,
  NotifyAuctionWonParams,
  NotifyAuctionLostParams,
  NotifyAuctionSoldParams,
  NotifyPaymentReceivedParams,
  NotifyWatchlistUrgentParams,
  NotifyContentParams,
  NotifyContentArchivedParams,
  NotificationType,
} from "./types";

// First configured frontend origin — emails must link to the SPA, not the API.
function appOrigin(): string {
  return (
    process.env.FRONTEND_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:5173"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)[0];
}

function getTwilio() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function getSendGrid() {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
  return sgMail;
}

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  auctionId?: string;
  sendSMS?: boolean;
  sendEmail?: boolean;
}

async function createNotification({
  userId,
  type,
  title,
  body,
  auctionId,
  sendSMS = false,
  sendEmail = false,
}: CreateNotificationParams): Promise<void> {
  // A notification (or email) must never break the action that triggered it —
  // a failed insert should not roll back a sale or a payment. So persistence
  // and delivery are each isolated and best-effort.
  try {
    const { error } = await supabaseAdmin.from("notifications").insert({
      user_id: userId,
      type,
      title,
      body,
      auction_id: auctionId,
    });
    if (error)
      console.error(`Notification insert failed (${type}):`, error.message);
  } catch (e) {
    console.error(`Notification insert threw (${type}):`, (e as Error).message);
  }

  // select("*") rather than naming columns: `phone` arrives via
  // phone_migration.sql, and a hand-applied migration lagging a deploy must
  // degrade to "no SMS", never to a failed lookup that kills email too.
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();
  if (!user) return;

  const phone = (user as { phone?: string | null }).phone;
  if (
    sendSMS &&
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_FROM_NUMBER &&
    phone
  ) {
    try {
      await getTwilio().messages.create({
        to: phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `${title} — ${body}`,
      });
    } catch (e) {
      console.error("SMS error:", (e as Error).message);
    }
  }

  if (
    sendEmail &&
    process.env.SENDGRID_API_KEY &&
    (user as { email?: string }).email
  ) {
    try {
      const sg = getSendGrid();
      await sg.send({
        to: (user as { email: string }).email,
        from: {
          email: process.env.SENDGRID_FROM_EMAIL!,
          name: process.env.SENDGRID_FROM_NAME!,
        },
        subject: title,
        html: emailTemplate(title, body),
      });
    } catch (e) {
      console.error("Email error:", (e as Error).message);
    }
  }
}

function emailTemplate(title: string, body: string): string {
  // There is no per-auction detail route in the SPA; the buyer/seller hub at
  // /home is where wins, bids, and activity live, so link there.
  const link = `${appOrigin()}/home`;
  return `
    <div style="background:#000000;padding:32px;font-family:Arial,sans-serif;color:#FFFFFF;max-width:600px;margin:0 auto;border:1px solid #222;">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase;">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px;">${title}</div>
      <div style="font-size:15px;color:#A0A0A0;line-height:1.6;margin-bottom:24px;">${body}</div>
      <a href="${link}" style="background:#FFFFFF;color:#000000;padding:12px 24px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;letter-spacing:0.5px;">Go to your dashboard →</a>
      <div style="margin-top:32px;font-size:11px;color:#444444;border-top:1px solid #222222;padding-top:16px;">Rocket Ranch Media Marketplace · Boca Chica, TX</div>
    </div>`;
}

export async function notifyOutbid({
  bidderId,
  auctionId,
  newBid,
}: NotifyOutbidParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: bidderId,
    type: "outbid",
    auctionId,
    title: "⚡ You've been outbid!",
    body: `Someone placed a $${newBid.toLocaleString()} bid on "${(auction as { title: string } | null)?.title}". Bid now to stay in the lead.`,
    sendEmail: true,
  });
}

export async function notifyAuctionWon({
  bidderId,
  auctionId,
  amount,
}: NotifyAuctionWonParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: bidderId,
    type: "auction_won",
    auctionId,
    title: "🏆 You won the auction!",
    body: `Congratulations! You won "${(auction as { title: string } | null)?.title}" for $${amount.toLocaleString()}. Complete your payment to receive the full-resolution content and rights transfer.`,
    sendEmail: true,
  });
}

export async function notifyAuctionLost({
  bidderId,
  auctionId,
}: NotifyAuctionLostParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: bidderId,
    type: "auction_lost",
    auctionId,
    title: "Auction ended",
    body: `"${(auction as { title: string } | null)?.title}" has closed. Browse new listings to find your next exclusive.`,
    sendEmail: false,
  });
}

// Seller-facing, sent the moment their auction closes with a winning bid (before
// the buyer pays). The matching "you've been paid" email fires later via
// notifyPaymentReceived once payment settles.
export async function notifyAuctionSold({
  photographerId,
  auctionId,
  amount,
}: NotifyAuctionSoldParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: photographerId,
    type: "auction_sold",
    auctionId,
    title: "🎉 Your auction sold!",
    body: `"${(auction as { title: string } | null)?.title}" sold for $${amount.toLocaleString()}. We'll notify you the moment the buyer completes payment and your payout is on the way.`,
    sendEmail: true,
  });
}

export async function notifyPaymentReceived({
  photographerId,
  auctionId,
  amount,
}: NotifyPaymentReceivedParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: photographerId,
    type: "payment_received",
    auctionId,
    title: "💰 You've been paid!",
    body: `$${amount.toLocaleString()} has been transferred to your account for "${(auction as { title: string } | null)?.title}". Funds typically arrive within 2 business days.`,
    sendEmail: true,
  });
}

export async function notifyWatchlistUrgent({
  auctionId,
  minutesLeft,
}: NotifyWatchlistUrgentParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title, current_bid")
    .eq("id", auctionId)
    .single();
  const { data: watchers } = await supabaseAdmin
    .from("watchlist")
    .select("user_id")
    .eq("auction_id", auctionId);
  for (const w of (watchers as Array<{ user_id: string }>) || []) {
    await createNotification({
      userId: w.user_id,
      type: "auction_ending",
      auctionId,
      title: `⚡ ${minutesLeft}m left on watched auction`,
      body: `"${(auction as { title: string; current_bid: number } | null)?.title}" is closing soon. Current bid: $${(auction as { title: string; current_bid: number } | null)?.current_bid?.toLocaleString()}`,
      sendEmail: false,
    });
  }
}

export async function notifyContentApproved({
  photographerId,
  auctionId,
}: NotifyContentParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: photographerId,
    type: "content_approved",
    auctionId,
    title: "✅ Your listing is live!",
    body: `"${(auction as { title: string } | null)?.title}" has been approved and is now visible to all verified buyers.`,
    sendEmail: true,
  });
}

export async function notifyContentRejected({
  photographerId,
  auctionId,
  reason,
}: NotifyContentParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: photographerId,
    type: "content_rejected",
    auctionId,
    title: "❌ Listing not approved",
    body: `"${(auction as { title: string } | null)?.title}" was not approved. Reason: ${reason}. Please review our content guidelines and resubmit.`,
    sendEmail: true,
  });
}

// Seller-facing, sent by the archive cron sweep (B3) when a marketplace listing
// goes 30 days with no license sold. The listing is now 'archived' and its rights
// have reverted to the photographer, who can relist it.
export async function notifyContentArchived({
  photographerId,
  auctionId,
}: NotifyContentArchivedParams): Promise<void> {
  const { data: auction } = await supabaseAdmin
    .from("auctions")
    .select("title")
    .eq("id", auctionId)
    .single();
  await createNotification({
    userId: photographerId,
    type: "content_archived",
    auctionId,
    title: "🗄️ Listing archived",
    body: `"${(auction as { title: string } | null)?.title}" spent 30 days on the marketplace without a license and has been archived. The rights have reverted to you — relist it anytime to put it back up for sale.`,
    sendEmail: true,
    // Spec requires email AND SMS for the archive notice (skipped per-user when
    // no phone is on file).
    sendSMS: true,
  });
}
