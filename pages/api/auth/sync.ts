/**
 * POST /api/auth/sync
 *
 * Called by the frontend after a successful Supabase OAuth sign-in.
 * Idempotent — safe to call on every login; returns the existing profile
 * if one already exists for this OAuth identity.
 *
 * First-time setup (no existing profile):
 *   - Buyers:        body must include { role: "buyer", handle } (self-serve)
 *   - Photographers: body must include { role: "photographer", handle, ... }
 *   - Admins:        body must include { role: "admin" }, plus adminCode matching
 *                    ADMIN_SIGNUP_SECRET when that env var is set (/mission-control)
 *   - Legacy buyers may still arrive with { inviteToken } from an approved app
 *
 * Auth: Bearer <supabase session access_token>
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabase, supabaseAdmin, formatUser } from "../../../lib/supabase";
import { findOrLinkUser } from "../../../lib/syncUser";
import { getOrCreateCustomer, createConnectAccount } from "../../../lib/stripe";
import type { DbUser, DbBuyerApplication } from "../../../lib/types";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  // Resolve the Supabase auth user from the Bearer token
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Bearer token required" });

  const {
    data: { user: authUser },
    error: authErr,
  } = await supabase.auth.getUser(token);
  if (authErr || !authUser)
    return res.status(401).json({ error: "Invalid or expired token" });

  const existing = await findOrLinkUser(authUser.id, authUser.email!);
  if (existing) {
    return res.status(200).json({ user: formatUser(existing), isNew: false });
  }

  // ── New user — determine role from body ──────────────────────────────────
  const {
    role,
    handle,
    displayName,
    inviteToken,
    bio,
    portfolioUrl,
    followerCount,
    adminCode,
  } = req.body as {
    role?: string;
    handle?: string;
    displayName?: string;
    inviteToken?: string;
    bio?: string;
    portfolioUrl?: string;
    followerCount?: number;
    adminCode?: string;
  };

  const email = authUser.email!;
  const name =
    displayName ??
    authUser.user_metadata?.full_name ??
    authUser.user_metadata?.name ??
    null;

  // ── Buyer path (self-serve) — a handle is all a buyer needs ───────────────
  if (role === "buyer" && !inviteToken) {
    if (!handle) {
      return res
        .status(400)
        .json({ error: "handle is required for buyer accounts" });
    }

    const { data: takenHandle } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("handle", handle)
      .single();
    if (takenHandle)
      return res.status(409).json({ error: "Handle already taken" });

    let buyerStripeCustomerId: string | null = null;
    try {
      const customer = await getOrCreateCustomer(email, name ?? undefined);
      buyerStripeCustomerId = customer.id;
    } catch {
      // Non-fatal in dev
    }

    const { data: buyer, error: buyerErr } = await supabaseAdmin
      .from("users")
      .insert({
        auth_id: authUser.id,
        email,
        display_name: name,
        handle,
        role: "buyer",
        follower_count: 0,
        stripe_customer_id: buyerStripeCustomerId,
        stripe_account_status: "n/a",
        verified: false,
        bid_status: "none", // must request + be approved before bidding
        sell_status: "none",
      })
      .select()
      .single();

    if (buyerErr) return res.status(500).json({ error: buyerErr.message });
    return res
      .status(201)
      .json({ user: formatUser(buyer as DbUser), isNew: true });
  }

  // ── Buyer path (legacy invite) — approved application → buyer account ──────
  if (inviteToken) {
    const { data: application } = await supabaseAdmin
      .from("buyer_applications")
      .select("*")
      .eq("invite_token", inviteToken)
      .single();

    if (!application) {
      return res
        .status(400)
        .json({ error: "Invalid or expired invite token." });
    }

    const app = application as DbBuyerApplication;
    if (app.status !== "approved") {
      return res
        .status(400)
        .json({
          error:
            "This invite link has already been used or is no longer valid.",
        });
    }

    // Stripe Customer for charging
    let stripeCustomerId: string | null = null;
    try {
      const customer = await getOrCreateCustomer(email, name ?? undefined);
      stripeCustomerId = customer.id;
    } catch {
      // Non-fatal in dev
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("users")
      .insert({
        auth_id: authUser.id,
        email,
        display_name: name,
        handle: null,
        role: "buyer",
        follower_count: app.total_followers ?? 0,
        stripe_customer_id: stripeCustomerId,
        stripe_account_status: "n/a",
        verified: true, // invite = admin-approved
        bid_status: "verified", // approved invite → can bid
        sell_status: "none",
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });

    // Consume the invite token so it can't be reused
    await supabaseAdmin
      .from("buyer_applications")
      .update({ invite_token: null })
      .eq("id", app.id);

    return res
      .status(201)
      .json({ user: formatUser(profile as DbUser), isNew: true });
  }

  // ── Photographer path ────────────────────────────────────────────────────
  if (role === "photographer") {
    if (!handle)
      return res
        .status(400)
        .json({ error: "handle is required for photographer accounts" });

    const { data: taken } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("handle", handle)
      .single();
    if (taken) return res.status(409).json({ error: "Handle already taken" });

    let stripeAccountId: string | null = null;
    try {
      const account = await createConnectAccount(
        email,
        name ?? undefined,
        handle,
      );
      stripeAccountId = account.id;
    } catch {
      // Non-fatal in dev
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("users")
      .insert({
        auth_id: authUser.id,
        email,
        display_name: name,
        handle,
        role: "photographer",
        bio: bio ?? null,
        portfolio_url: portfolioUrl ?? null,
        follower_count: followerCount ?? 0,
        stripe_account_id: stripeAccountId,
        stripe_account_status: stripeAccountId
          ? "pending_onboarding"
          : "pending",
        verified: false, // legacy; selling is gated by sell_status
        sell_status: "pending", // admin reviews before they can list
        bid_status: "none",
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });
    return res
      .status(201)
      .json({ user: formatUser(profile as DbUser), isNew: true });
  }

  // ── Admin path — self-registration via the private /mission-control page ──
  if (role === "admin") {
    // When ADMIN_SIGNUP_SECRET is configured, the caller must supply it as
    // adminCode. Without it set (dev), the obscure URL is the only gate.
    const requiredCode = process.env.ADMIN_SIGNUP_SECRET;
    if (requiredCode && adminCode !== requiredCode) {
      return res
        .status(403)
        .json({ error: "Invalid admin registration code." });
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("users")
      .insert({
        auth_id: authUser.id,
        email,
        display_name: name,
        handle: null,
        role: "admin",
        follower_count: 0,
        stripe_account_status: "n/a",
        verified: true,
        bid_status: "none",
        sell_status: "none",
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });
    return res
      .status(201)
      .json({ user: formatUser(profile as DbUser), isNew: true });
  }

  return res.status(400).json({
    error:
      "role is required for new accounts. Pass 'buyer', 'photographer', or 'admin'.",
  });
}

export default withErrorHandling(handler);
