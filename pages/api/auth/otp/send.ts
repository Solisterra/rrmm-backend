import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { supabaseAdmin } from "../../../../lib/supabase";
import sgMail from "@sendgrid/mail";

// Where the magic LINK should land after Supabase verifies it. The 6-digit
// code works on any origin, but the link redirect must be on Supabase's
// allowlist (Authentication → URL Configuration → Redirect URLs); otherwise
// Supabase silently falls back to the project's Site URL. In dev we prefer a
// localhost origin if one is configured in FRONTEND_URL.
function redirectTarget(): string {
  const origins = (process.env.FRONTEND_URL ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const base =
    (process.env.NODE_ENV !== "production" &&
      origins.find((o) => /localhost|127\.0\.0\.1/.test(o))) ||
    origins[0];
  return `${base}/auth/callback`;
}

function emailHtml(code: string, link?: string): string {
  const button = link
    ? `<a href="${link}" style="display:inline-block;background:#fff;color:#000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:4px;margin-bottom:24px">Sign in instantly</a>
  <p style="color:#A0A0A0;line-height:1.6;margin-bottom:8px">…or enter this code manually:</p>`
    : "";
  return `<div style="background:#000;padding:32px;font-family:Arial,sans-serif;color:#fff;max-width:500px;margin:0 auto;border:1px solid #222">
  <div style="font-size:10px;color:#A0A0A0;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase">Media Marketplace</div>
  <div style="font-size:18px;font-weight:bold;margin-bottom:12px">Your sign-in code</div>
  <p style="color:#A0A0A0;line-height:1.6;margin-bottom:20px">Use the link or code below to sign in. It expires shortly.</p>
  ${button}
  <div style="font-size:36px;font-weight:bold;letter-spacing:12px;margin-bottom:24px">${code}</div>
  <p style="font-size:12px;color:#555">If you didn't request this, ignore this email.</p>
</div>`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email is required" });

  // generateLink lets us read the OTP server-side and deliver it via SendGrid
  // (instead of Supabase's built-in mail), so the code works regardless of
  // origin/redirect allowlists.
  //
  // The catch that broke local dev: for a brand-new email, generateLink
  // auto-creates the auth user but leaves it UNCONFIRMED, and an unconfirmed
  // user's magiclink OTP fails verifyOtp with "Token has expired or is
  // invalid". (Existing/confirmed accounts — e.g. the ones tested in prod —
  // verify fine, which is why this only surfaced for fresh sign-ups locally.)
  // So: confirm the user first, then mint the code they'll actually use.
  const redirectTo = redirectTarget();
  const mint = () =>
    supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });

  let { data, error } = await mint();
  if (error) return res.status(400).json({ error: error.message });

  if (data.user && !data.user.email_confirmed_at) {
    const { error: confirmErr } = await supabaseAdmin.auth.admin.updateUserById(
      data.user.id,
      { email_confirm: true },
    );
    if (confirmErr) return res.status(400).json({ error: confirmErr.message });
    ({ data, error } = await mint());
    if (error) return res.status(400).json({ error: error.message });
  }

  const code = data.properties?.email_otp;
  const link = data.properties?.action_link;
  if (!code) {
    return res.status(400).json({ error: "Could not generate code" });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  // Without email configured, sign-in is impossible in prod. In dev, return the
  // code so local testing still works without a mail provider.
  if (!apiKey || !fromEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[otp] ${email} code=${code}`);
      return res.status(200).json({ success: true, devCode: code, devLink: link });
    }
    return res.status(500).json({ error: "Email is not configured" });
  }

  sgMail.setApiKey(apiKey);
  try {
    await sgMail.send({
      to: email,
      from: {
        email: fromEmail,
        name: process.env.SENDGRID_FROM_NAME ?? "Rocket Ranch Media Marketplace",
      },
      subject: "Your RRMM sign-in code",
      html: emailHtml(code, link),
    });
  } catch (e) {
    // Surface the failure instead of returning success on a silent miss — the
    // old code swallowed this, so a broken send looked like a sent email and
    // the failure resurfaced later as "Token has expired or is invalid" at the
    // verify step (no code was ever delivered).
    const msg = e instanceof Error ? e.message : "Email send failed";
    console.error("SendGrid error:", msg);
    // In dev, don't let a broken/invalid SendGrid key block local sign-in:
    // hand back the code so the verify flow can still be exercised end-to-end.
    if (process.env.NODE_ENV !== "production") {
      console.log(`[otp] ${email} code=${code}`);
      return res
        .status(200)
        .json({ success: true, devCode: code, devLink: link, emailError: msg });
    }
    return res.status(502).json({ error: "Could not send sign-in email" });
  }

  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
