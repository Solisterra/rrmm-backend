/**
 * POST /api/auth/session
 *
 * Exchanges Supabase session tokens for httpOnly cookies. Used by the magic-link
 * callback: the link returns tokens in the URL fragment (client-side), and the
 * browser can't set httpOnly cookies itself — so it POSTs them here and we set
 * the cookies after verifying the access token is genuine.
 *
 * Body: { accessToken: string, refreshToken: string }
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabase } from "../../../lib/supabase";
import { setAuthCookies } from "../../../lib/cookies";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const { accessToken, refreshToken } = req.body as {
    accessToken?: string;
    refreshToken?: string;
  };
  if (!accessToken || !refreshToken) {
    return res
      .status(400)
      .json({ error: "accessToken and refreshToken are required" });
  }

  // Verify the access token is valid before trusting it into a cookie.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  setAuthCookies(res, accessToken, refreshToken);
  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
