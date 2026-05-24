import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { supabase, formatUser } from "../../../../lib/supabase";
import { findOrLinkUser } from "../../../../lib/syncUser";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) {
    return res.status(400).json({ error: "email and code are required" });
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });

  if (error || !data.session || !data.user) {
    return res.status(401).json({ error: error?.message ?? "Invalid or expired code" });
  }

  const { session, user: authUser } = data;

  const existing = await findOrLinkUser(authUser.id, authUser.email!);

  return res.status(200).json({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    user: existing ? formatUser(existing) : null,
    isNew: !existing,
  });
}

export default withErrorHandling(handler);
