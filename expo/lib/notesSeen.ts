// expo/lib/notesSeen.ts — "new since I last looked" for the Notes & documents surface.
// Independent of the chat-thread unread marker (that uses last_read_at).
import { supabase } from "@/lib/supabase";

/** My notes_last_seen_at for this room, or null if I've never opened notes here. */
export async function fetchNotesLastSeen(roomId: string): Promise<string | null> {
  if (!roomId) return null;
  const { data, error } = await supabase
    .from("room_read_state")
    .select("notes_last_seen_at")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) {
    console.error("fetchNotesLastSeen failed", error);
    return null;
  }
  return data?.notes_last_seen_at ?? null;
}

/** Stamp my notes-seen marker for this room to now. Safe to call on open. */
export async function markNotesSeen(roomId: string): Promise<void> {
  if (!roomId) return;
  const { error } = await supabase.rpc("mark_notes_seen", { p_room_id: roomId });
  if (error) console.error("markNotesSeen failed", error);
}
