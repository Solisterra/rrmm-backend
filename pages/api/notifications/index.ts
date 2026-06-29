import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import type { DbUser, DbNotification } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const u = user as DbUser;

  if (req.method === "GET") {
    const { data } = await supabaseQuery(
      supabaseAdmin
        .from("notifications")
        .select("*")
        .eq("user_id", u.id)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    const unread =
      (data as DbNotification[] | null)?.filter((n) => !n.read).length ?? 0;
    return res.status(200).json({ notifications: data || [], unread });
  }

  if (req.method === "PATCH") {
    const { id, readAll } = req.body as { id?: string; readAll?: boolean };
    if (readAll) {
      await supabaseAdmin
        .from("notifications")
        .update({ read: true })
        .eq("user_id", u.id);
    } else if (id) {
      await supabaseAdmin
        .from("notifications")
        .update({ read: true })
        .eq("id", id)
        .eq("user_id", u.id);
    }
    return res.status(200).json({ success: true });
  }

  if (req.method === "DELETE") {
    const { id } = req.body as { id?: string };
    const query = supabaseAdmin
      .from("notifications")
      .delete()
      .eq("user_id", u.id);
    if (id) query.eq("id", id); // delete one; otherwise clear all for the user
    await query;
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withErrorHandling(handler);
