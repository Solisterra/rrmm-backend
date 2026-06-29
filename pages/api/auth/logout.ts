/**
 * POST /api/auth/logout
 *
 * Clears the httpOnly session cookies and makes a best-effort call to revoke
 * the user's other sessions so refresh tokens can't be replayed after logout.
 *
 * Auth: httpOnly session cookie (falls back to Bearer <access_token>).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin } from "../../../lib/supabase";
import { getAccessToken, clearAuthCookies } from "../../../lib/cookies";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const token = getAccessToken(req);
  if (token) {
    const { data } = await supabaseAdmin.auth
      .getUser(token)
      .catch(() => ({ data: null }));
    const userId = (data as { user?: { id: string } } | null)?.user?.id;
    if (userId) {
      await supabaseAdmin.auth.admin.signOut(userId, "others").catch(() => {});
    }
  }

  clearAuthCookies(res);
  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
