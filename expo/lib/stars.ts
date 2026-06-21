// expo/lib/stars.ts — personal (per-member) note stars.
// A star is private to the signed-in member; RLS enforces "your own only".
import { supabase } from "@/lib/supabase";
import { getCurrentMemberId } from "@/lib/member";

/** Set of artifact ids the signed-in member has starred (in their rooms). */
export async function fetchMyStarredIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("note_stars")
    .select("artifact_id");
  if (error) {
    console.error("fetchMyStarredIds failed", error);
    return new Set();
  }
  return new Set((data ?? []).map((r: { artifact_id: string }) => r.artifact_id));
}

/** Star an artifact for the signed-in member (idempotent — ignores duplicate). */
export async function starNote(artifactId: string): Promise<void> {
  const memberId = await getCurrentMemberId();
  if (!memberId) throw new Error("Could not resolve your member id.");
  const { error } = await supabase
    .from("note_stars")
    .upsert(
      { member_id: memberId, artifact_id: artifactId },
      { onConflict: "member_id,artifact_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** Remove the signed-in member's star from an artifact. */
export async function unstarNote(artifactId: string): Promise<void> {
  const memberId = await getCurrentMemberId();
  if (!memberId) throw new Error("Could not resolve your member id.");
  const { error } = await supabase
    .from("note_stars")
    .delete()
    .eq("member_id", memberId)
    .eq("artifact_id", artifactId);
  if (error) throw error;
}
