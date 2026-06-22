import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import sgMail from "@sendgrid/mail";
import { v4 as uuidv4 } from "uuid";
import type { DbUser, DbBuyerApplication } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  const u = user as DbUser;
  const { applicationId, decision, note, directInviteEmail } = req.body as {
    applicationId?: string;
    decision?: string;
    note?: string;
    directInviteEmail?: string;
  };

  if (directInviteEmail) {
    const inviteToken = uuidv4();
    const appUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    await supabaseAdmin.from("buyer_applications").upsert(
      {
        email: directInviteEmail,
        name: directInviteEmail,
        channel_name: "Direct Invite",
        note: `Direct invite sent by admin ${u.display_name || u.email}`,
        platforms: [],
        status: "approved",
        reviewed_by: u.id,
        reviewed_at: new Date().toISOString(),
        invite_token: inviteToken,
        invite_sent_at: new Date().toISOString(),
      },
      { onConflict: "email" },
    );
    await _sendInviteEmail(directInviteEmail, inviteToken, appUrl!);
    return res.status(200).json({
      success: true,
      message: `Direct invite sent to ${directInviteEmail}`,
      inviteLink: `${appUrl}/join?token=${inviteToken}`,
    });
  }

  if (!applicationId || !decision)
    return res
      .status(400)
      .json({ error: "applicationId and decision required" });
  if (!["approved", "rejected"].includes(decision))
    return res
      .status(400)
      .json({ error: "Decision must be approved or rejected" });

  const { data: app } = await supabaseAdmin
    .from("buyer_applications")
    .select("*")
    .eq("id", applicationId)
    .single();
  if (!app) return res.status(404).json({ error: "Application not found" });

  const a = app as DbBuyerApplication;
  if (a.status !== "pending")
    return res.status(400).json({ error: `Application already ${a.status}` });

  const appUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  const inviteToken = decision === "approved" ? uuidv4() : null;

  await supabaseAdmin
    .from("buyer_applications")
    .update({
      status: decision,
      reviewed_by: u.id,
      reviewed_at: new Date().toISOString(),
      review_note: note || null,
      invite_token: inviteToken,
      invite_sent_at: decision === "approved" ? new Date().toISOString() : null,
    })
    .eq("id", applicationId);

  if (decision === "approved") {
    await _sendApprovalEmail(
      a.email,
      a.name,
      a.channel_name,
      inviteToken!,
      appUrl,
    );
    return res.status(200).json({
      success: true,
      decision,
      message: `${a.name} approved. Login invite sent to ${a.email}.`,
      inviteLink: `${appUrl}/join?token=${inviteToken}`,
    });
  } else {
    await _sendRejectionEmail(a.email, a.name, note);
    return res
      .status(200)
      .json({
        success: true,
        decision,
        message: `${a.name}'s application rejected.`,
      });
  }
}

function sendMail(msg: Parameters<typeof sgMail.send>[0]) {
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  return sgMail
    .send(msg)
    .catch((e: Error) => console.error("Email error:", e.message));
}

const FROM = {
  email: process.env.SENDGRID_FROM_EMAIL!,
  name: process.env.SENDGRID_FROM_NAME!,
};

async function _sendApprovalEmail(
  email: string,
  name: string,
  channel: string,
  token: string,
  appUrl: string,
) {
  await sendMail({
    to: email,
    from: FROM,
    subject: "You're approved — Rocket Ranch Media Marketplace",
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px">Welcome, ${name} 🎉</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:20px">Your application for <strong style="color:#fff">${channel}</strong> has been approved.</p>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:24px">Click below to set up your account. Your access link expires in 72 hours.</p>
      <a href="${appUrl}/join?token=${token}" style="background:#fff;color:#000;padding:14px 28px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">Set Up My Account →</a>
    </div>`,
  });
}

async function _sendRejectionEmail(
  email: string,
  name: string,
  reason?: string,
) {
  await sendMail({
    to: email,
    from: FROM,
    subject: "Your RRMM application — update",
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:18px;font-weight:bold;margin-bottom:12px">Hi ${name},</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:16px">Thank you for applying. After review, we're unable to approve your application at this time.</p>
      ${reason ? `<p style="color:#A0A0A0;line-height:1.6;margin-bottom:16px"><strong style="color:#fff">Reason:</strong> ${reason}</p>` : ""}
      <p style="color:#A0A0A0;line-height:1.6">To appeal, email <a href="mailto:access@rocketranch.com" style="color:#fff">access@rocketranch.com</a>.</p>
    </div>`,
  });
}

async function _sendInviteEmail(email: string, token: string, appUrl: string) {
  await sendMail({
    to: email,
    from: FROM,
    subject: "You've been invited — Rocket Ranch Media Marketplace",
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px">You're invited 🚀</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:24px">You've been personally invited to access Rocket Ranch Media Marketplace.</p>
      <a href="${appUrl}/join?token=${token}" style="background:#fff;color:#000;padding:14px 28px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">Accept Invitation →</a>
    </div>`,
  });
}

export default withErrorHandling(handler);
