import { createClient } from "@supabase/supabase-js";

let _anon = null;
let _admin = null;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function getAnon() {
  return (_anon ??= createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  ));
}

function getAdmin() {
  return (_admin ??= createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  ));
}

const lazy = (getter) =>
  new Proxy(
    {},
    {
      get(_, prop) {
        const client = getter();
        const val = client[prop];
        return typeof val === "function" ? val.bind(client) : val;
      },
    },
  );

export const supabase = lazy(getAnon);
export const supabaseAdmin = lazy(getAdmin);

export async function getUserFromRequest(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
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
  return profile || null;
}

// Unwraps a Supabase query result; throws on real DB errors so withErrorHandling
// can return a proper 500. PGRST116 ("no rows found" from .single()) is treated
// as data: null — callers check !data and return 404 themselves.
export async function supabaseQuery(queryPromise) {
  const { data, error, count } = await queryPromise;
  if (error && error.code !== "PGRST116") {
    const err = new Error(error.message);
    err.status = 500;
    throw err;
  }
  return { data, count };
}

export async function getAllUsers({ role, limit = 50, offset = 0 } = {}) {
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
    const err = new Error(error.message);
    err.status = 500;
    throw err;
  }

  return {
    users: data || [],
    count: count ?? 0,
    limit,
    offset,
  };
}
