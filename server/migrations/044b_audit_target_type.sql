-- 044b_audit_target_type.sql
-- Extend audit_events.target_type vocabulary to include 'practice_profile' so the
-- branding-registry RPCs (submit/review/link) can write their audit rows.
-- Current vocab: attachment, artifact, message (or null). Additive only.
-- Apply by hand in the Supabase SQL editor. Idempotent.

alter table public.audit_events drop constraint if exists audit_events_target_type_check;
alter table public.audit_events add constraint audit_events_target_type_check
  check (
    target_type is null
    or target_type = any (array['attachment','artifact','message','practice_profile'])
  );
