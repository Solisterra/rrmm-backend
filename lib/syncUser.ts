import { supabaseAdmin } from "./supabase";
import type { DbUser } from "./types";

/**
 * Finds an existing user row by Supabase auth_id.
 * Falls back to email lookup and links the auth_id for accounts created
 * before OTP was the primary auth method (seeded rows, legacy email/password).
 */
export async function findOrLinkUser(authId: string, email: string): Promise<DbUser | null> {
  const { data: byAuthId } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("auth_id", authId)
    .single();

  if (byAuthId) return byAuthId as DbUser;

  const { data: byEmail } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (byEmail) {
    await supabaseAdmin
      .from("users")
      .update({ auth_id: authId })
      .eq("id", (byEmail as DbUser).id);
    return { ...(byEmail as DbUser), auth_id: authId };
  }

  return null;
}
