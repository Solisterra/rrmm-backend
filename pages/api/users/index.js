/**
 * GET /api/users
 * Returns the authenticated user's profile
 */
import { getUserFromRequest } from "../../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const users = await getAllUsers();

  return res.status(200).json({ users });
}
