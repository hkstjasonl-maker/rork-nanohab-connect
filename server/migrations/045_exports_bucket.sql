-- 045_exports_bucket.sql
-- Private storage bucket for generated PDF documents (Layer 2a export).
-- Like meeting-recordings / message-attachments: NOT public. The backend writes
-- with the service role and hands the caller a short-TTL signed URL; members
-- never get a durable public link. Apply by hand in the Supabase SQL editor.

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;

-- No member-facing storage RLS policies: all reads are via short-TTL signed URLs
-- minted server-side, all writes are service-role. (Same posture as the other
-- private buckets, which also have no public policies.)
