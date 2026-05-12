import { withErrorHandling } from '../../../lib/api.js';
/**
 * POST /api/access/review  — admin: approve or reject a buyer application
 */
import { supabaseAdmin, getUserFromRequest } from '../../../lib/supabase.js';
import sgMail from '@sendgrid/mail';
import { v4 as uuidv4 } from 'uuid';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const user = await getUserFromRequest(req);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { applicationId, decision, note, directInviteEmail } = req.body;

  // ── Direct invite (no application required) ──────────────────────────
  if (directInviteEmail) {
    const inviteToken = uuidv4();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;

    await supabaseAdmin.from('buyer_applications').upsert({
      email: directInviteEmail,
      name: directInviteEmail,
      channel_name: 'Direct Invite',
      note: `Direct invite sent by admin ${user.display_name || user.email}`,
      platforms: [],
      status: 'approved',
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      invite_token: inviteToken,
      invite_sent_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    await _sendInviteEmail(directInviteEmail, inviteToken, appUrl);

    return res.status(200).json({
      success: true,
      message: `Direct invite sent to ${directInviteEmail}`,
      inviteLink: `${appUrl}/join?token=${inviteToken}`,
    });
  }

  // ── Review an existing application ───────────────────────────────────
  if (!applicationId || !decision) return res.status(400).json({ error: 'applicationId and decision required' });
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });

  const { data: app } = await supabaseAdmin
    .from('buyer_applications').select('*').eq('id', applicationId).single();
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'pending') return res.status(400).json({ error: `Application already ${app.status}` });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const inviteToken = decision === 'approved' ? uuidv4() : null;

  await supabaseAdmin.from('buyer_applications').update({
    status: decision,
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
    invite_token: inviteToken,
    invite_sent_at: decision === 'approved' ? new Date().toISOString() : null,
  }).eq('id', applicationId);

  if (decision === 'approved') {
    await _sendApprovalEmail(app.email, app.name, app.channel_name, inviteToken, appUrl);
    return res.status(200).json({
      success: true, decision,
      message: `${app.name} approved. Login invite sent to ${app.email}.`,
      inviteLink: `${appUrl}/join?token=${inviteToken}`,
    });
  } else {
    await _sendRejectionEmail(app.email, app.name, note);
    return res.status(200).json({ success: true, decision, message: `${app.name}'s application rejected.` });
  }
}

function sendMail(msg) {
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  return sgMail.send(msg).catch(e => console.error('Email error:', e.message));
}

const FROM = { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME };

async function _sendApprovalEmail(email, name, channel, token, appUrl) {
  await sendMail({
    to: email, from: FROM,
    subject: "You're approved — Rocket Ranch Media Marketplace",
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px">Welcome, ${name} 🎉</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:20px">Your application for <strong style="color:#fff">${channel}</strong> has been approved.</p>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:24px">Click below to set up your account. Your access link expires in 72 hours.</p>
      <a href="${appUrl}/join?token=${token}" style="background:#fff;color:#000;padding:14px 28px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">Set Up My Account →</a>
      <p style="color:#444;font-size:12px;margin-top:32px;border-top:1px solid #222;padding-top:16px">Rocket Ranch Media Marketplace · Boca Chica, TX</p>
    </div>`,
  });
}

async function _sendRejectionEmail(email, name, reason) {
  await sendMail({
    to: email, from: FROM,
    subject: 'Your RRMM application — update',
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:18px;font-weight:bold;margin-bottom:12px">Hi ${name},</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:16px">Thank you for applying. After review, we're unable to approve your application at this time.</p>
      ${reason ? `<p style="color:#A0A0A0;line-height:1.6;margin-bottom:16px"><strong style="color:#fff">Reason:</strong> ${reason}</p>` : ''}
      <p style="color:#A0A0A0;line-height:1.6">To appeal, email <a href="mailto:access@rocketranch.com" style="color:#fff">access@rocketranch.com</a>.</p>
    </div>`,
  });
}

async function _sendInviteEmail(email, token, appUrl) {
  await sendMail({
    to: email, from: FROM,
    subject: "You've been invited — Rocket Ranch Media Marketplace",
    html: `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:600px;margin:0 auto;border:1px solid #222">
      <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
      <div style="font-size:20px;font-weight:bold;margin-bottom:12px">You're invited 🚀</div>
      <p style="color:#A0A0A0;line-height:1.6;margin-bottom:24px">You've been personally invited to access Rocket Ranch Media Marketplace — exclusive Starbase content, auctioned in real time.</p>
      <a href="${appUrl}/join?token=${token}" style="background:#fff;color:#000;padding:14px 28px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">Accept Invitation →</a>
      <p style="color:#444;font-size:12px;margin-top:32px;border-top:1px solid #222;padding-top:16px">This link expires in 72 hours · Rocket Ranch Media Marketplace</p>
    </div>`,
  });
}

export default withErrorHandling(handler);
