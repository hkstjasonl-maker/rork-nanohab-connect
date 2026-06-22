-- 049_wet_sign.sql
-- Sign-off Layer 3: pair a wet-ink-signed PAPER scan to an issued document.
-- The scan is an ADDITION to the e-signed original, never a replacement. The scan
-- is PHI (a clinical document image) -> private bucket, B5 security treatment.
-- Apply by hand in the Supabase SQL editor. Idempotent.

-- columns on issued_documents (the verifiable-doc registry from 046)
alter table public.issued_documents
  add column if not exists wet_signed_scan_path text,
  add column if not exists wet_signed_at        timestamptz,
  add column if not exists wet_signed_by         uuid references public.members(id);

-- private bucket for scanned wet-signed copies (mirrors exports/branding: private,
-- service-role only; reads via short-TTL signed URLs minted server-side).
insert into storage.buckets (id, name, public)
values ('signed-scans', 'signed-scans', false)
on conflict (id) do nothing;

-- NOTE: no member-facing storage policies (same posture as exports/branding/message-
-- attachments). The backend validates + stores under service role; the scan is never
-- shown on the public verify page (only a boolean "paper copy on file" may be exposed).
