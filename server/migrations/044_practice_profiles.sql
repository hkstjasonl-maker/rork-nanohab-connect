-- 044_practice_profiles.sql
-- Registered, APPROVED branding entities for exported clinical documents.
-- Governance model: a profile must be submitted -> approved before it can brand
-- any document. Branding is customizable (incl. full white-label); the verify-QR
-- + document-ID integrity layer is rendered by the backend on EVERY export and is
-- NOT part of this configurable data, so it can never be turned off.
--
-- A clinician may practise at multiple sites -> many approved profiles, linked via
-- member_practice_profiles. An org sets a default; a clinician may use any profile
-- they are approved-linked to.
--
-- All writes go through SECURITY DEFINER RPCs (submit/approve/reject/link/default)
-- so the approval gate cannot be bypassed. Every state change is audited.
-- Apply by hand in the Supabase SQL editor. Idempotent.

-- ergonomics: who is an org admin? (org_owner today; expand if more roles exist)
create or replace function public.is_org_admin(p_member uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from members
    where id = p_member and org_id = p_org
      and org_role in ('org_owner','org_admin') and is_active
  );
$fn$;

-- ============================ tables ====================================
create table if not exists public.practice_profiles (
  id              uuid primary key default gen_random_uuid(),
  -- ownership: a profile belongs to an org OR an individual clinician (xor-ish;
  -- at least one set). Org profiles are admin-managed; member profiles are personal.
  owner_org_id    uuid references public.organizations(id) on delete cascade,
  owner_member_id uuid references public.members(id) on delete cascade,
  -- branding payload (what shows on the document)
  display_name    text not null,
  legal_name      text,
  address         text,
  registration_no text,                    -- the clinic/centre's own licence/reg
  logo_path       text,                    -- private bucket object path (nullable)
  brand_color     text,                    -- hex, optional
  branding_tier   text not null default 'cobrand'
                    check (branding_tier in ('cobrand','whitelabel')),
  -- approval state machine
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected','suspended')),
  submitted_by    uuid references public.members(id),
  submitted_at    timestamptz not null default now(),
  reviewed_by     uuid references public.members(id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz not null default now(),
  check (owner_org_id is not null or owner_member_id is not null)
);

create index if not exists pp_org_idx    on public.practice_profiles(owner_org_id);
create index if not exists pp_member_idx on public.practice_profiles(owner_member_id);
create index if not exists pp_status_idx on public.practice_profiles(status);

-- which clinicians may USE which approved profiles (multi-site practitioners)
create table if not exists public.member_practice_profiles (
  member_id      uuid not null references public.members(id) on delete cascade,
  profile_id     uuid not null references public.practice_profiles(id) on delete cascade,
  is_org_default boolean not null default false,
  linked_by      uuid references public.members(id),
  linked_at      timestamptz not null default now(),
  primary key (member_id, profile_id)
);
create index if not exists mpp_member_idx  on public.member_practice_profiles(member_id);
create index if not exists mpp_profile_idx on public.member_practice_profiles(profile_id);

-- ============================ RLS =======================================
alter table public.practice_profiles enable row level security;
alter table public.member_practice_profiles enable row level security;

-- read a profile if: I own it (member), it's my org's profile, or I'm linked to it.
drop policy if exists pp_read on public.practice_profiles;
create policy pp_read on public.practice_profiles
  for select using (
    owner_member_id = current_member_id()
    or (owner_org_id is not null and owner_org_id = current_member_org())
    or exists (select 1 from member_practice_profiles mpp
               where mpp.profile_id = practice_profiles.id
                 and mpp.member_id = current_member_id())
  );

-- read my own profile links
drop policy if exists mpp_read on public.member_practice_profiles;
create policy mpp_read on public.member_practice_profiles
  for select using (member_id = current_member_id());

-- all writes via RPCs only
revoke all on public.practice_profiles        from public, anon, authenticated;
revoke all on public.member_practice_profiles from public, anon, authenticated;
grant select on public.practice_profiles        to authenticated;
grant select on public.member_practice_profiles to authenticated;

-- ============================ RPCs ======================================
-- submit a new profile (status=pending). Org profile requires org-admin; a
-- personal profile is owned by the submitting member.
create or replace function public.submit_practice_profile(
  p_scope text,                 -- 'org' | 'member'
  p_display_name text,
  p_legal_name text default null,
  p_address text default null,
  p_registration_no text default null,
  p_brand_color text default null,
  p_branding_tier text default 'cobrand'
) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare v_me uuid := current_member_id(); v_org uuid; v_id uuid;
        v_owner_org uuid := null; v_owner_member uuid := null;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;
  select org_id into v_org from members where id = v_me;
  if p_branding_tier not in ('cobrand','whitelabel') then
    raise exception 'invalid branding_tier'; end if;

  if p_scope = 'org' then
    if not is_org_admin(v_me, v_org) then
      raise exception 'org branding requires an org admin' using errcode='42501'; end if;
    v_owner_org := v_org;
  elsif p_scope = 'member' then
    v_owner_member := v_me;
  else
    raise exception 'scope must be org or member';
  end if;

  insert into practice_profiles
    (owner_org_id, owner_member_id, display_name, legal_name, address,
     registration_no, brand_color, branding_tier, status, submitted_by)
  values
    (v_owner_org, v_owner_member, p_display_name, p_legal_name, p_address,
     p_registration_no, p_brand_color, p_branding_tier, 'pending', v_me)
  returning id into v_id;

  insert into audit_events (actor_member_id, action, target_type, target_id, detail)
  values (v_me, 'draft', 'practice_profile', v_id,
          jsonb_build_object('event','profile_submitted','scope',p_scope,
                             'tier',p_branding_tier,'name',p_display_name));
  return v_id;
end $fn$;

-- approve / reject (NanoHab trust authority; for org profiles an org-admin may also
-- approve their own org's profiles once we delegate — for now: platform review).
-- Gated here to org-admin of the owning org OR (future) a platform reviewer flag.
create or replace function public.review_practice_profile(
  p_profile_id uuid, p_decision text, p_note text default null
) returns void
language plpgsql security definer set search_path = public as $fn$
declare v_me uuid := current_member_id(); v_org uuid; v_owner_org uuid;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;
  if p_decision not in ('approved','rejected','suspended') then
    raise exception 'invalid decision'; end if;
  select org_id into v_org from members where id = v_me;
  select owner_org_id into v_owner_org from practice_profiles where id = p_profile_id;
  -- org profiles: an admin of that org may review. (Personal/platform review is a
  -- later delegation; today personal profiles are reviewed by platform via service role.)
  if v_owner_org is null or not is_org_admin(v_me, v_owner_org) then
    raise exception 'not authorized to review this profile' using errcode='42501';
  end if;

  update practice_profiles
     set status = p_decision, reviewed_by = v_me, reviewed_at = now(), review_note = p_note
   where id = p_profile_id;

  insert into audit_events (actor_member_id, action, target_type, target_id, detail)
  values (v_me, 'approve', 'practice_profile', p_profile_id,
          jsonb_build_object('event','profile_reviewed','decision',p_decision));
end $fn$;

-- link an approved profile to a member (so they may use it). Org-admin links org
-- members; a member may link their own personal approved profile to themselves.
create or replace function public.link_practice_profile(
  p_profile_id uuid, p_member_id uuid default null, p_is_org_default boolean default false
) returns void
language plpgsql security definer set search_path = public as $fn$
declare v_me uuid := current_member_id(); v_org uuid;
        v_owner_org uuid; v_owner_member uuid; v_status text; v_target uuid;
begin
  if v_me is null then raise exception 'no member context' using errcode='42501'; end if;
  select org_id into v_org from members where id = v_me;
  select owner_org_id, owner_member_id, status
    into v_owner_org, v_owner_member, v_status
    from practice_profiles where id = p_profile_id;
  if v_status <> 'approved' then
    raise exception 'profile is not approved' using errcode='42501'; end if;

  v_target := coalesce(p_member_id, v_me);
  -- authorization: org profile -> org admin links any org member; personal profile
  -- -> only the owner links themselves.
  if v_owner_org is not null then
    if not is_org_admin(v_me, v_owner_org) then
      raise exception 'org admin required to link org profile' using errcode='42501'; end if;
  else
    if v_owner_member <> v_me or v_target <> v_me then
      raise exception 'can only link your own personal profile to yourself' using errcode='42501'; end if;
  end if;

  if p_is_org_default then
    -- clear any existing org default for this member's org profiles
    update member_practice_profiles mpp set is_org_default = false
      where mpp.member_id = v_target
        and exists (select 1 from practice_profiles pp
                    where pp.id = mpp.profile_id and pp.owner_org_id = v_owner_org);
  end if;

  insert into member_practice_profiles (member_id, profile_id, is_org_default, linked_by)
  values (v_target, p_profile_id, coalesce(p_is_org_default,false), v_me)
  on conflict (member_id, profile_id)
  do update set is_org_default = excluded.is_org_default, linked_by = excluded.linked_by;

  insert into audit_events (actor_member_id, action, target_type, target_id, detail)
  values (v_me, 'draft', 'practice_profile', p_profile_id,
          jsonb_build_object('event','profile_linked','member',v_target,
                             'org_default',coalesce(p_is_org_default,false)));
end $fn$;

revoke execute on function public.submit_practice_profile(text,text,text,text,text,text,text) from public, anon;
revoke execute on function public.review_practice_profile(uuid,text,text) from public, anon;
revoke execute on function public.link_practice_profile(uuid,uuid,boolean) from public, anon;
grant execute on function public.submit_practice_profile(text,text,text,text,text,text,text) to authenticated;
grant execute on function public.review_practice_profile(uuid,text,text) to authenticated;
grant execute on function public.link_practice_profile(uuid,uuid,boolean) to authenticated;
grant execute on function public.is_org_admin(uuid,uuid) to authenticated;
