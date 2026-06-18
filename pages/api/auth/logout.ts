/**
 * POST /api/auth/logout
 *
 * Supabase JWTs are stateless — the frontend clears its token before calling
 * this. We make a best-effort call to revoke all other sessions for the user
 * so refresh tokens can't be replayed after logout.
 *
 * Auth: Bearer <supabase session access_token>
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin } from "../../../lib/supabase";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    const { data } = await supabaseAdmin.auth.getUser(token).catch(() => ({ data: null }));
    const userId = (data as { user?: { id: string } } | null)?.user?.id;
    if (userId) {
      await supabaseAdmin.auth.admin.signOut(userId, "others").catch(() => {});
    }
  }

  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
