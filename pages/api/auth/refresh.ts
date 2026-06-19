import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabase } from "../../../lib/supabase";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) return res.status(400).json({ error: "refreshToken is required" });

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session) {
    return res.status(401).json({ error: error?.message ?? "Session expired. Please sign in again." });
  }

  return res.status(200).json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  });
}

export default withErrorHandling(handler);
