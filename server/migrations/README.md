# NanoHab Connect — database migrations

These SQL migrations are applied BY HAND in the Supabase SQL editor (project
`vpqrqivadavuuiaoxuvi`, Singapore region), in numeric order. They are kept here
so the schema history is version-controlled alongside the code.

NOTE: migrations 026–041 predate this folder and live only in Supabase history;
this folder starts at 042. Backfill earlier ones here when convenient.

## Apply order (042+)
- 042_notes_last_seen.sql      — notes "new since I last looked" (room_read_state.notes_last_seen_at + mark_notes_seen)
- 043_session_meta.sql         — ai_artifacts.session_date + session_type + audited set_session_meta
- 044_practice_profiles.sql    — branding registry: practice_profiles + member_practice_profiles + approval RPCs + is_org_admin
- 044b_audit_target_type.sql   — extend audit_events.target_type to include 'practice_profile'
- 045_exports_bucket.sql       — private 'exports' storage bucket for generated PDFs
- 046_issued_documents.sql     — registry of issued PDFs (source of truth for the public verify page); leak-proof

## Status: all of the above are APPLIED in production as of 2026-06-21.

- 047_branding_bucket.sql     -- private 'branding' bucket + set_profile_logo RPC (logo upload) [APPLIED]
- 048_profile_tier.sql        -- governed branding_tier: member set_profile_tier cobrand-only + operator upgrade [APPLIED]
- 049_wet_sign.sql            -- Sign-off Layer 3: issued_documents.wet_signed_* + 'signed-scans' bucket [PENDING]