import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin } from "../../../lib/supabase";
import { getOrCreateCustomer, createConnectAccount } from "../../../lib/stripe";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const { authId, email, displayName, handle, role, followerCount, phone } =
    req.body as {
      authId?: string;
      email?: string;
      displayName?: string;
      handle?: string;
      role?: string;
      followerCount?: number;
      phone?: string;
    };

  if (!authId || !email || !role)
    return res.status(400).json({ error: "authId, email, role required" });
  if (!["photographer", "buyer"].includes(role))
    return res
      .status(400)
      .json({ error: "Role must be photographer or buyer" });

  // Buyers are self-service (B10): they land in the default 'marketplace' tier
  // with instant fixed-price access and no follower minimum or manual review.
  // The old 50k-follower gate belonged to the retired influencer-only model;
  // bidding remains a separate verify-to-bid upgrade (bid_status='verified').

  if (role === "photographer" && handle) {
    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("handle", handle)
      .single();
    if (existing)
      return res.status(409).json({ error: "Handle already taken" });
  }

  let stripeCustomerId: string | null = null;
  let stripeAccountId: string | null = null;

  if (role === "buyer") {
    const customer = await getOrCreateCustomer(email, displayName);
    stripeCustomerId = customer.id;
  }

  if (role === "photographer") {
    const account = await createConnectAccount(email, displayName, handle);
    stripeAccountId = account.id;
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .insert({
      auth_id: authId,
      email,
      display_name: displayName,
      handle,
      // Only reference the column when a phone was given — keeps registration
      // working if phone_migration.sql hasn't been applied yet.
      ...(phone ? { phone } : {}),
      role,
      follower_count: followerCount || 0,
      stripe_customer_id: stripeCustomerId,
      stripe_account_id: stripeAccountId,
      stripe_account_status:
        role === "photographer" ? "pending_onboarding" : "n/a",
      verified: false,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ user: data });
}

export default withErrorHandling(handler);
