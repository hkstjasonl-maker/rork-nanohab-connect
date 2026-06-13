import { supabase } from "@/lib/supabase";

/**
 * Resolves the current member id via RLS indirection.
 * Selects `id` from `members` where `auth_user_id = auth.uid()`.
 * Always call this before any member-scoped DB operation — never compare
 * to `auth.uid()` directly in app code.
 */
export async function getCurrentMemberId(): Promise<string | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return null;
  }

  const { data, error } = await supabase
    .from("members")
    .select("id")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();

  if (error) {
    console.error("getCurrentMemberId failed:", error.message);
    return null;
  }

  return data?.id ?? null;
}
