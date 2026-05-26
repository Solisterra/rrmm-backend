/**
 * POST /api/auth/sync
 *
 * Called by the frontend after a successful Supabase OAuth sign-in.
 * Idempotent — safe to call on every login; returns the existing profile
 * if one already exists for this OAuth identity.
 *
 * First-time setup (no existing profile):
 *   - Photographers: body must include { role: "photographer", handle }
 *   - Buyers:        body must include { inviteToken } from the /join?token= link
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
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Resolve the Supabase auth user from the Bearer token
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Bearer token required" });

  const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !authUser) return res.status(401).json({ error: "Invalid or expired token" });

  const existing = await findOrLinkUser(authUser.id, authUser.email!);
  if (existing) {
    return res.status(200).json({ user: formatUser(existing), isNew: false });
  }

  // ── New user — determine role from body ──────────────────────────────────
  const { role, handle, displayName, inviteToken } = req.body as {
    role?: string;
    handle?: string;
    displayName?: string;
    inviteToken?: string;
  };

  const email = authUser.email!;
  const name = displayName ?? authUser.user_metadata?.full_name ?? authUser.user_metadata?.name ?? null;

  // ── Buyer path — must arrive via invite token ────────────────────────────
  if (inviteToken || role === "buyer") {
    if (!inviteToken) {
      return res.status(403).json({
        error: "Buyer accounts require an invitation. Apply at the marketplace homepage.",
      });
    }

    const { data: application } = await supabaseAdmin
      .from("buyer_applications")
      .select("*")
      .eq("invite_token", inviteToken)
      .single();

    if (!application) {
      return res.status(400).json({ error: "Invalid or expired invite token." });
    }

    const app = application as DbBuyerApplication;
    if (app.status !== "approved") {
      return res.status(400).json({ error: "This invite link has already been used or is no longer valid." });
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
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });

    // Consume the invite token so it can't be reused
    await supabaseAdmin
      .from("buyer_applications")
      .update({ invite_token: null })
      .eq("id", app.id);

    return res.status(201).json({ user: formatUser(profile as DbUser), isNew: true });
  }

  // ── Photographer path ────────────────────────────────────────────────────
  if (role === "photographer") {
    if (!handle) return res.status(400).json({ error: "handle is required for photographer accounts" });

    const { data: taken } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("handle", handle)
      .single();
    if (taken) return res.status(409).json({ error: "Handle already taken" });

    let stripeAccountId: string | null = null;
    try {
      const account = await createConnectAccount(email, name ?? undefined, handle);
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
        follower_count: 0,
        stripe_account_id: stripeAccountId,
        stripe_account_status: stripeAccountId ? "pending_onboarding" : "pending",
        verified: false, // admin reviews manually
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });
    return res.status(201).json({ user: formatUser(profile as DbUser), isNew: true });
  }

  // ── Admin path — used only by internal tooling ───────────────────────────
  if (role === "admin") {
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
      })
      .select()
      .single();

    if (profileErr) return res.status(500).json({ error: profileErr.message });
    return res.status(201).json({ user: formatUser(profile as DbUser), isNew: true });
  }

  return res.status(400).json({
    error: "role is required for new accounts. Pass 'photographer' or provide an inviteToken for buyers.",
  });
}

export default withErrorHandling(handler);
