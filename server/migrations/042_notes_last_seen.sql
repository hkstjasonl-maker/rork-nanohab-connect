-- 042_notes_last_seen.sql
-- "New since I last looked" for the Notes & documents surface.
-- The chat-thread unread feature already uses room_read_state.last_read_at
-- (via UnreadBanner + mark_room_read). Notes needs an INDEPENDENT marker so the
-- two never clobber each other -> add a separate notes_last_seen_at column on the
-- SAME per-(member,room) row, with its own setter RPC.
-- Apply by hand in the Supabase SQL editor. Idempotent.

-- 1) second, independent timestamp on the existing read-state row ---------------
alter table public.room_read_state
  add column if not exists notes_last_seen_at timestamptz;

-- (nullable on purpose: null = "never opened notes here" -> first visit shows
--  nothing as new, which is the correct, non-noisy default.)

-- 2) member-lane setter: stamp MY notes-seen marker for a room I belong to.
--    Mirrors mark_room_read exactly, but writes the notes column only, so the
--    chat unread marker (last_read_at) is untouched.
--    current_member_id()-based -> KEEP default grants (do NOT three-role-revoke).
create or replace function public.mark_notes_seen(p_room_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
  v_now    timestamptz := now();
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'no member context';
  end if;
  if not public.is_room_member(p_room_id) then
    raise exception 'not a member of this room';
  end if;
  insert into public.room_read_state (member_id, room_id, notes_last_seen_at)
  values (v_member, p_room_id, v_now)
  on conflict (member_id, room_id)
  do update set notes_last_seen_at = excluded.notes_last_seen_at;
  return v_now;
end;
$$;
