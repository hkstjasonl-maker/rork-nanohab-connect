// expo/lib/reviews.ts — "please review this note" requests + receipts.
import { supabase } from "@/lib/supabase";

export type RoomTeammate = { member_id: string; full_name: string | null; discipline: string | null };

export type ReviewRequest = {
  id: string;
  artifact_id: string;
  room_id: string;
  requested_by: string;
  requested_for: string;
  created_at: string;
  seen_at: string | null;
  reviewed_at: string | null;
};

/** Co-members of a room (for the "ask who?" picker), excluding an optional member. */
export async function fetchRoomTeammates(roomId: string, excludeMemberId?: string): Promise<RoomTeammate[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select("member_id, member:members!member_id(full_name, discipline)")
    .eq("room_id", roomId);
  if (error) {
    console.error("fetchRoomTeammates failed", error);
    return [];
  }
  const rows = (data ?? []) as unknown as {
    member_id: string;
    member: { full_name: string | null; discipline: string | null } | null;
  }[];
  return rows
    .filter((r) => r.member_id !== excludeMemberId)
    .map((r) => ({
      member_id: r.member_id,
      full_name: r.member?.full_name ?? null,
      discipline: r.member?.discipline ?? null,
    }));
}

/** All review requests visible to me in this room (ones I sent or that are for me). */
export async function fetchRoomReviewRequests(roomId: string): Promise<ReviewRequest[]> {
  if (!roomId) return [];
  const { data, error } = await supabase
    .from("note_review_requests")
    .select("id, artifact_id, room_id, requested_by, requested_for, created_at, seen_at, reviewed_at")
    .eq("room_id", roomId);
  if (error) {
    console.error("fetchRoomReviewRequests failed", error);
    return [];
  }
  return (data ?? []) as ReviewRequest[];
}

/** Ask one or more teammates to review an artifact. */
export async function requestReview(artifactId: string, forMemberIds: string[]): Promise<void> {
  for (const m of forMemberIds) {
    const { error } = await supabase.rpc("request_review", {
      p_artifact_id: artifactId,
      p_for_member: m,
    });
    if (error) throw error;
  }
}

/** Mark a note I was asked to review as seen (call on open). Safe to call always. */
export async function markReviewSeen(artifactId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_review_seen", { p_artifact_id: artifactId });
  if (error) console.error("markReviewSeen failed", error);
}

/** Explicitly acknowledge review. */
export async function markReviewDone(artifactId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_review_done", { p_artifact_id: artifactId });
  if (error) throw error;
}
