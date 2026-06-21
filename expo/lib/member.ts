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


export type MyProfile = {
  id: string;
  full_name: string | null;
  discipline: string | null;
  credentials: string | null;
  registration_no: string | null;
};

export async function getMyProfile(): Promise<MyProfile | null> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return null;
  const { data, error } = await supabase
    .from("members")
    .select("id, full_name, discipline, credentials, registration_no")
    .eq("auth_user_id", u.user.id)
    .maybeSingle();
  if (error) {
    console.error("getMyProfile failed", error);
    return null;
  }
  return (data ?? null) as MyProfile | null;
}

export async function updateMyProfile(
  patch: Partial<Pick<MyProfile, "credentials" | "registration_no" | "discipline">>
): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error("Not signed in.");
  const { error } = await supabase
    .from("members")
    .update(patch)
    .eq("auth_user_id", u.user.id);
  if (error) throw error;
}
