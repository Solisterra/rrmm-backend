import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
import type { DbUser, DbBuyerApplication } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") return submitApplication(req, res);
  if (req.method === "GET") return listApplications(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

async function submitApplication(req: NextApiRequest, res: NextApiResponse) {
  const { name, email, channelName, contentFocus, note, platforms } =
    req.body as {
      name?: string;
      email?: string;
      channelName?: string;
      contentFocus?: string;
      note?: string;
      platforms?: Array<{ followers?: string }>;
    };

  if (!name || !email || !channelName || !note || !platforms?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const totalFollowers = platforms.reduce(
    (s, p) => s + (parseInt((p.followers ?? "").replace(/,/g, "")) || 0),
    0,
  );
  if (totalFollowers < 50000) {
    return res.status(400).json({
      error: "Minimum 50,000 combined followers required across all platforms.",
      totalFound: totalFollowers,
    });
  }

  const { data: existing } = await supabaseAdmin
    .from("buyer_applications")
    .select("id, status")
    .eq("email", email)
    .single();

  if (existing) {
    const e = existing as { status: string };
    if (e.status === "approved")
      return res
        .status(409)
        .json({
          error:
            "This email already has an approved buyer account. Check your inbox for your login link.",
        });
    if (e.status === "pending")
      return res
        .status(409)
        .json({
          error:
            "An application for this email is already under review. We'll be in touch within 24 hours.",
        });
    if (e.status === "rejected")
      return res
        .status(409)
        .json({
          error:
            "A previous application from this email was not approved. Contact access@rocketranch.com to appeal.",
        });
  }

  const ip =
    (req.headers["x-forwarded-for"] as string) ||
    req.socket?.remoteAddress ||
    "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  const { data, error } = await supabaseAdmin
    .from("buyer_applications")
    .insert({
      name,
      email,
      channel_name: channelName,
      content_focus: contentFocus,
      note,
      platforms,
      ip_address: ip,
      user_agent: userAgent,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const { data: admins } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("role", "admin");
  for (const admin of (admins as Array<{ id: string }>) || []) {
    await supabaseAdmin.from("notifications").insert({
      user_id: admin.id,
      type: "new_listing",
      title: "📬 New Buyer Application",
      body: `${name} from ${channelName} has applied for buyer access. ${totalFollowers.toLocaleString()} total followers.`,
    });
  }

  return res.status(201).json({
    success: true,
    message:
      "Application received. We'll review it within 24 hours and email you directly.",
    applicationId: (data as { id: string }).id,
  });
}

async function listApplications(req: NextApiRequest, res: NextApiResponse) {
  const user = await getUserFromRequest(req);
  if (!user || (user as DbUser).role !== "admin")
    return res.status(403).json({ error: "Admin only" });

  const {
    status = "pending",
    limit = "50",
    offset = "0",
  } = req.query as Record<string, string>;

  const { data, error } = await supabaseAdmin
    .from("buyer_applications")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: true })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });

  const applications = (data as DbBuyerApplication[]).map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    channel: a.channel_name,
    note: a.note ?? "",
    platforms: a.platforms ?? [],
    appliedAt: new Date(a.created_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    status: a.status,
  }));

  return res.status(200).json({ applications, count: applications.length });
}

export default withErrorHandling(handler);
