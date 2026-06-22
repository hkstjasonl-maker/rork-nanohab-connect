-- 047_branding_bucket.sql
-- Private bucket for practice-profile LOGOS + a gated RPC to set logo_path.
-- A logo is org/profile-scoped branding (not clinical), so it lives in its own
-- bucket, never in message-attachments. Written by the service role (the upload
-- endpoint validates/strips first); the path is set via an authorization-checked
-- RPC so a member can't point a profile at an arbitrary object.
-- Apply by hand in the Supabase SQL editor. Idempotent.

insert into storage.buckets (id, name, public)
values ('branding', 'branding', false)
on conflict (id) do nothing;

-- Set (or clear) a profile's logo_path. Authorization mirrors who may manage the
-- profile: org profile -> an org admin of that org; personal profile -> the owner.
-- current_member_id()-based -> KEEP default grants (do NOT three-role-revoke).
create or replace function public.set_profile_logo(
  p_profile_id uuid,
  p_logo_path text
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_me uuid := current_member_id();
  v_owner_org uuid; v_owner_member uuid;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;
  select owner_org_id, owner_member_id
    into v_owner_org, v_owner_member
    from practice_profiles where id = p_profile_id;
  if not found then raise exception 'profile not found'; end if;

  if v_owner_org is not null then
    if not is_org_admin(v_me, v_owner_org) then
      raise exception 'org admin required' using errcode='42501'; end if;
  else
    if v_owner_member <> v_me then
      raise exception 'not your profile' using errcode='42501'; end if;
  end if;

  update practice_profiles set logo_path = p_logo_path where id = p_profile_id;

  insert into audit_events (actor_member_id, action, target_type, target_id, detail)
  values (v_me, 'draft', 'practice_profile', p_profile_id,
          jsonb_build_object('event','profile_logo_set','has_logo', p_logo_path is not null));
end $fn$;

revoke execute on function public.set_profile_logo(uuid,text) from public, anon;
grant execute on function public.set_profile_logo(uuid,text) to authenticated;
