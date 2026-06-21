-- 046_issued_documents.sql
-- Registry of ISSUED PDF documents — the source of truth the public verify page
-- reads. One row per export (per doc_id). Holds ONLY what a verification page may
-- reveal: doc id, signer identity, dates, branding, status. NO clinical content
-- (no note text, no template/title) — the verify page must be leak-proof since
-- anyone holding the paper can scan the QR.
-- Apply by hand in the Supabase SQL editor. Idempotent.

create table if not exists public.issued_documents (
  doc_id           text primary key,                 -- e.g. NHC-7F3A-22C9
  artifact_id      uuid references public.ai_artifacts(id) on delete set null,
  room_id          uuid,
  -- frozen signer identity (copied from approver_snapshot at issue time)
  signer_name        text,
  signer_credentials text,
  signer_reg_no      text,
  signed_at        timestamptz,                       -- when the note was approved
  issued_at        timestamptz not null default now(),-- when this PDF was generated
  -- branding context (so the verify page can re-skin at white-label tier).
  -- NB: a clinic NAME is not PHI; we store it to attribute the verify page.
  branding_profile_id uuid references public.practice_profiles(id) on delete set null,
  branding_name       text,
  branding_tier       text,                            -- null | cobrand | whitelabel
  status           text not null default 'valid'
                     check (status in ('valid','revoked','superseded')),
  issued_by_member uuid references public.members(id),
  created_at       timestamptz not null default now()
);

create index if not exists issued_docs_artifact_idx on public.issued_documents(artifact_id);

-- RLS: this table is written ONLY by the service role (export endpoint) and read
-- ONLY by the service role (the public verify endpoint runs server-side and
-- returns a curated, leak-proof subset). No member/anon access at all.
alter table public.issued_documents enable row level security;
revoke all on public.issued_documents from public, anon, authenticated;
grant all on public.issued_documents to service_role;
-- (no policies for authenticated/anon -> they can't read the raw table; the verify
--  endpoint is the only public surface and it hand-picks the fields it returns.)
