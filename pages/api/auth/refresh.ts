import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabase } from "../../../lib/supabase";
import {
  REFRESH_COOKIE,
  setAuthCookies,
  clearAuthCookies,
} from "../../../lib/cookies";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  // Refresh token comes from the httpOnly cookie; fall back to the body for
  // non-browser callers.
  const refreshToken =
    req.cookies?.[REFRESH_COOKIE] ||
    (req.body as { refreshToken?: string }).refreshToken;
  if (!refreshToken)
    return res.status(401).json({ error: "Not authenticated" });

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    clearAuthCookies(res); // stale refresh token — drop it so we stop retrying
    return res.status(401).json({
      error: error?.message ?? "Session expired. Please sign in again.",
    });
  }

  setAuthCookies(res, data.session.access_token, data.session.refresh_token);
  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
