-- 048_profile_tier.sql
-- Governed branding_tier changes. ASYMMETRIC by design:
--   * UPGRADE to 'whitelabel' is a PAID entitlement -> operator-only (done via a
--     require_operator backend endpoint that writes directly under service role).
--   * A member who is org-admin of the profile's org may only set 'cobrand'
--     (a downgrade / lateral move) -- never grant themselves the paid tier.
-- Both paths are audited (tier changes are billing-relevant events).
-- Apply by hand in the Supabase SQL editor. Idempotent.

-- Member-callable RPC: org-admin may set their org profile to 'cobrand' only.
-- (Personal profiles: the owner may also set 'cobrand'.) Whitelabel is rejected
-- here with a clear message pointing at the operator path.
create or replace function public.set_profile_tier(
  p_profile_id uuid,
  p_tier text
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_me uuid := current_member_id();
  v_owner_org uuid; v_owner_member uuid; v_old text;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;
  if p_tier <> 'cobrand' then
    raise exception 'only co-brand can be set here; white-label is granted by NanoHab'
      using errcode='42501';
  end if;

  select owner_org_id, owner_member_id, branding_tier
    into v_owner_org, v_owner_member, v_old
    from practice_profiles where id = p_profile_id;
  if not found then raise exception 'profile not found'; end if;

  if v_owner_org is not null then
    if not is_org_admin(v_me, v_owner_org) then
      raise exception 'org admin required' using errcode='42501'; end if;
  else
    if v_owner_member <> v_me then
      raise exception 'not your profile' using errcode='42501'; end if;
  end if;

  update practice_profiles set branding_tier = p_tier where id = p_profile_id;

  insert into audit_events (actor_member_id, action, target_type, target_id, detail)
  values (v_me, 'draft', 'practice_profile', p_profile_id,
          jsonb_build_object('event','profile_tier_set','from',v_old,'to',p_tier,'by','member'));
end $fn$;

revoke execute on function public.set_profile_tier(uuid,text) from public, anon;
grant execute on function public.set_profile_tier(uuid,text) to authenticated;
