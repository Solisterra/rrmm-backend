import { supabaseAdmin } from "./supabase";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import type {
  NotifyOutbidParams,
  NotifyAuctionWonParams,
  NotifyAuctionLostParams,
  NotifyPaymentReceivedParams,
  NotifyWatchlistUrgentParams,
  NotifyContentParams,
  NotificationType,
} from "./types";

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
  await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    type,
    title,
    body,
    auction_id: auctionId,
  });

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("email, display_name")
    .eq("id", userId)
    .single();
  if (!user) return;

  if (sendSMS && process.env.TWILIO_ACCOUNT_SID) {
    try {
      getTwilio(); // initialise — phone lookup handled in production
    } catch (e) {
      console.error("SMS error:", (e as Error).message);
    }
  }

  if (sendEmail && process.env.SENDGRID_API_KEY && (user as { email?: string }).email) {
    try {
      const sg = getSendGrid();
      await sg.send({
        to: (user as { email: string }).email,
        from: {
          email: process.env.SENDGRID_FROM_EMAIL!,
          name: process.env.SENDGRID_FROM_NAME!,
        },
        subject: title,
        html: emailTemplate(title, body, auctionId),
      });
    } catch (e) {
      console.error("Email error:", (e as Error).message);
    }
  }
}

function emailTemplate(title: string, body: string, auctionId?: string): string {
  const link = auctionId
    ? `${process.env.NEXT_PUBLIC_APP_URL}/auction/${auctionId}`
    : process.env.NEXT_PUBLIC_APP_URL;
  return `
    <div style="background:#000000;padding:32px;font-family:Arial,sans-serif;color:#FFFFFF;max-width:600px;margin:0 auto;border:1px solid #222;">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase;">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px;">${title}</div>
      <div style="font-size:15px;color:#A0A0A0;line-height:1.6;margin-bottom:24px;">${body}</div>
      ${auctionId ? `<a href="${link}" style="background:#FFFFFF;color:#000000;padding:12px 24px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;letter-spacing:0.5px;">View Auction →</a>` : ""}
      <div style="margin-top:32px;font-size:11px;color:#444444;border-top:1px solid #222222;padding-top:16px;">Rocket Ranch Media Marketplace · Boca Chica, TX</div>
    </div>`;
}

export async function notifyOutbid({ bidderId, auctionId, newBid }: NotifyOutbidParams): Promise<void> {
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

export async function notifyAuctionWon({ bidderId, auctionId, amount }: NotifyAuctionWonParams): Promise<void> {
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

export async function notifyAuctionLost({ bidderId, auctionId }: NotifyAuctionLostParams): Promise<void> {
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

export async function notifyPaymentReceived({ photographerId, auctionId, amount }: NotifyPaymentReceivedParams): Promise<void> {
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

export async function notifyWatchlistUrgent({ auctionId, minutesLeft }: NotifyWatchlistUrgentParams): Promise<void> {
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

export async function notifyContentApproved({ photographerId, auctionId }: NotifyContentParams): Promise<void> {
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

export async function notifyContentRejected({ photographerId, auctionId, reason }: NotifyContentParams): Promise<void> {
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
