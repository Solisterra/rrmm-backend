/**
 * POST /api/capabilities/request
 *
 * A signed-in member requests a capability by submitting the detailed profile
 * form: "buyer" (to place bids) or "seller" (to create listings). The relevant
 * status is set to "pending" for admin review. Members can hold BOTH, so this
 * never removes the capability they already have.
 *
 * Auth: Bearer <supabase session access_token>
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  formatUser,
} from "../../../lib/supabase";
import { getOrCreateCustomer, createConnectAccount } from "../../../lib/stripe";
import type { DbUser } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;

  const {
    capability,
    name,
    portfolioUrl,
    focus,
    followerCount,
    about,
    studio,
    handle,
  } = req.body as {
    capability?: "buyer" | "seller";
    name?: string;
    portfolioUrl?: string;
    focus?: string;
    followerCount?: number;
    about?: string;
    studio?: string;
    handle?: string;
  };

  if (capability !== "buyer" && capability !== "seller")
    return res
      .status(400)
      .json({ error: "capability must be 'buyer' or 'seller'" });

  const current = capability === "buyer" ? u.bid_status : u.sell_status;
  if (current === "verified")
    return res.status(409).json({
      error: `You are already a verified ${capability === "buyer" ? "bidder" : "seller"}.`,
    });
  if (current === "pending")
    return res
      .status(409)
      .json({ error: "This request is already under review." });

  const bio = [
    studio ? `Studio: ${studio}` : null,
    focus ? `Shoots: ${focus}` : null,
    about,
  ]
    .filter(Boolean)
    .join("\n");

  // The form captures the same person regardless of capability, so we refresh
  // the shared profile fields and flip just the requested status to pending.
  const update: Record<string, unknown> = {
    display_name: name ?? u.display_name,
    bio: bio || u.bio,
    portfolio_url: portfolioUrl ?? u.portfolio_url,
    follower_count: followerCount ?? u.follower_count,
  };

  if (capability === "buyer") {
    update.bid_status = "pending";
    if (!u.stripe_customer_id) {
      try {
        const customer = await getOrCreateCustomer(u.email, name ?? undefined);
        update.stripe_customer_id = customer.id;
      } catch {
        // Non-fatal in dev
      }
    }
  } else {
    update.sell_status = "pending";
    if (!u.stripe_account_id) {
      try {
        const account = await createConnectAccount(
          u.email,
          name ?? undefined,
          u.handle ?? undefined,
        );
        update.stripe_account_id = account.id;
        update.stripe_account_status = "pending_onboarding";
      } catch {
        // Non-fatal in dev
      }
    }
  }

  // Buyers reach "verify to bid" with just a handle — let them set or correct it
  // here (and let legacy invite-buyers, who have none, choose one).
  if (handle && handle !== u.handle) {
    const { data: taken } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("handle", handle)
      .single();
    if (taken) return res.status(409).json({ error: "Handle already taken" });
    update.handle = handle;
  }

  const { data: updated, error } = await supabaseAdmin
    .from("users")
    .update(update)
    .eq("id", u.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify admins there's a request to review.
  const { data: admins } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("role", "admin");
  for (const admin of (admins as Array<{ id: string }> | null) ?? []) {
    await supabaseAdmin.from("notifications").insert({
      user_id: admin.id,
      type: "new_listing",
      title:
        capability === "buyer"
          ? "🙋 New bidder verification"
          : "📷 New seller verification",
      body: `${name ?? u.email} requested ${capability === "buyer" ? "bidding" : "selling"} access.`,
    });
  }

  return res.status(200).json({ user: formatUser(updated as DbUser) });
}

export default withErrorHandling(handler);
