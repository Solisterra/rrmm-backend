import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextApiRequest } from "next";
import type { DbUser, Role } from "./types";
import { getAccessToken } from "./cookies";

let _anon: SupabaseClient | null = null;
let _admin: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function getAnon(): SupabaseClient {
  return (_anon ??= createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  ));
}

function getAdmin(): SupabaseClient {
  return (_admin ??= createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  ));
}

function lazy(getter: () => SupabaseClient): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get(_, prop: string | symbol) {
      const client = getter();
      const val = (client as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? (val as Function).bind(client) : val;
    },
  });
}

export const supabase = lazy(getAnon);
export const supabaseAdmin = lazy(getAdmin);

export async function getUserFromRequest(
  req: NextApiRequest,
): Promise<DbUser | null> {
  // Dev bypass — allows testing with seeded fake emails without OAuth.
  // Never active in production; gated by both NODE_ENV and a header so it
  // can't be triggered accidentally even in staging.
  if (process.env.NODE_ENV !== "production") {
    const devEmail = req.headers["x-dev-email"] as string | undefined;
    if (devEmail) {
      const { data } = await supabaseAdmin
        .from("users")
        .select("*")
        .eq("email", devEmail)
        .single();
      return (data as DbUser) || null;
    }
  }

  const token = getAccessToken(req);
  if (!token) return null;
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("auth_id", user.id)
    .single();
  return (profile as DbUser) || null;
}

export function formatUser(profile: DbUser) {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name ?? "",
    handle: profile.handle ?? "",
    role: profile.role,
    verified: profile.verified ?? false,
    bidStatus: profile.bid_status ?? "none",
    sellStatus: profile.sell_status ?? "none",
    canBid: (profile.bid_status ?? "none") === "verified",
    canSell: (profile.sell_status ?? "none") === "verified",
    stripeStatus: profile.stripe_account_status ?? "pending",
    ...(profile.follower_count
      ? { followerCount: profile.follower_count }
      : {}),
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.portfolio_url ? { portfolioUrl: profile.portfolio_url } : {}),
  };
}

interface SupabaseQueryResult<T> {
  data: T | null;
  count: number | null;
}

interface StatusError extends Error {
  status?: number;
}

export async function supabaseQuery<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryPromise: PromiseLike<{
    data: T | null;
    error: any;
    count: number | null;
  }>,
): Promise<SupabaseQueryResult<T>> {
  const { data, error, count } = await queryPromise;
  if (error && error.code !== "PGRST116") {
    const err: StatusError = new Error(error.message);
    err.status = 500;
    throw err;
  }
  return { data, count };
}

interface GetAllUsersOptions {
  role?: Role;
  limit?: number;
  offset?: number;
}

export async function getAllUsers({
  role,
  limit = 50,
  offset = 0,
}: GetAllUsersOptions = {}) {
  let query = supabaseAdmin
    .from("users")
    .select(
      "id, email, handle, display_name, role, verified, follower_count, avatar_url, stripe_account_status, total_earned, total_spent, total_sales, total_wins, created_at, updated_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (role) {
    query = query.eq("role", role);
  }

  const { data, error, count } = await query;
  if (error) {
    const err: StatusError = new Error(error.message);
    err.status = 500;
    throw err;
  }

  return {
    users: (data as DbUser[]) || [],
    count: count ?? 0,
    limit,
    offset,
  };
}
