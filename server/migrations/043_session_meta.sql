-- 043_session_meta.sql
-- Adds clinician-recordable SESSION metadata to notes, for the exported document.
-- Integrity model:
--   * created_at (existing)  = AUTHORED / ISSUE date. System-set, IMMUTABLE. Never editable.
--   * session_date (new)     = when the encounter actually happened. Clinician-set, RECORDED.
--   * session_type (new)     = assessment / therapy / consultation / review / other.
-- Any change to session metadata is written to audit_events (old -> new), so a
-- backdated session date can never be set silently. The PDF always shows the true
-- immutable issue date; a > 48h gap renders a factual "late entry" line.
-- Apply by hand in the Supabase SQL editor. Idempotent.

alter table public.ai_artifacts
  add column if not exists session_date date,
  add column if not exists session_type text;

-- constrain session_type to a known vocabulary (nullable = unspecified)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_artifacts_session_type_check') then
    alter table public.ai_artifacts
      add constraint ai_artifacts_session_type_check
      check (session_type is null or session_type in
        ('assessment','therapy','consultation','review','screening','other'));
  end if;
end $$;

-- Member-lane setter: record session date/type for a note in a room I belong to.
-- Writes an audit row capturing the change (old -> new) every time.
-- current_member_id()-based -> KEEP default grants (do NOT three-role-revoke).
create or replace function public.set_session_meta(
  p_artifact_id uuid,
  p_session_date date,
  p_session_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := current_member_id();
  v_room   uuid;
  v_old_date date;
  v_old_type text;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;

  select room_id, session_date, session_type
    into v_room, v_old_date, v_old_type
    from ai_artifacts where id = p_artifact_id;
  if v_room is null then raise exception 'artifact not found'; end if;
  if not is_room_member(v_room) then
    raise exception 'not a member of this room' using errcode='42501';
  end if;

  if p_session_type is not null and p_session_type not in
     ('assessment','therapy','consultation','review','screening','other') then
    raise exception 'invalid session_type';
  end if;

  update ai_artifacts
     set session_date = p_session_date,
         session_type = p_session_type
   where id = p_artifact_id;

  -- record the change (old -> new) for tamper-evidence
  insert into audit_events (actor_member_id, action, target_type, target_id, room_id, detail)
  values (v_me, 'draft', 'artifact', p_artifact_id, v_room,
          jsonb_build_object(
            'event', 'session_meta_set',
            'old_session_date', v_old_date,
            'new_session_date', p_session_date,
            'old_session_type', v_old_type,
            'new_session_type', p_session_type));
end $$;
