import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { supabase } from "../../../../lib/supabase";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email is required" });

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${frontendUrl}/auth/callback`,
    },
  });

  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ success: true });
}

export default withErrorHandling(handler);
