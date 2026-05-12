import { createClient } from "@supabase/supabase-js";

// Defer client creation to first use — missing env vars fail per-request
// instead of crashing the whole module at load time
let _anon = null;
let _admin = null;

function getAnon() {
  return (_anon ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ));
}

function getAdmin() {
  return (_admin ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
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
