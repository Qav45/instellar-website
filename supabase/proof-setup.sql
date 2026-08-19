-- ============================================================
-- Instellar: PROOF ON PUNISHMENTS
-- Paste into the Supabase SQL editor and RUN, after
-- panel-upgrade.sql. Safe to run again.
--
-- Lets staff attach evidence to any punishment they submit from
-- the panel (manual action or a template step): screenshots,
-- mp4 clips, mp3 audio, or plain links (Discord message, YouTube,
-- medal.tv, ...). Uploads land in a Storage bucket named 'proof';
-- links are stored as-is. Both end up in mod_actions.proof so the
-- audit log, the Approvals tab and player history can show them.
--
-- If an upload fails with a mime-type error, the bucket's type list is
-- out of date: just run this file again, it overwrites the list.
--
-- The bucket is PUBLIC (anyone with the exact URL can open a file)
-- so links work anywhere staff paste them. File paths are random,
-- so they can't be guessed. Only staff can upload; only Admins and
-- up can delete a file (from the Supabase dashboard).
-- ============================================================

-- 1) Column: list of proof URLs (uploaded files and/or links)
alter table public.mod_actions add column if not exists proof text[];

-- 2) Storage bucket for uploads (50 MB per file, media types only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proof', 'proof', true, 52428800,
  array['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp',
        'image/heic','image/heif',
        'video/mp4','video/webm','video/quicktime',
        'audio/mpeg','audio/mp3','audio/mp4','audio/wav','audio/x-wav','audio/ogg','audio/webm'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 3) Who may do what with the files
drop policy if exists proof_read on storage.objects;
create policy proof_read on storage.objects
  for select to public using (bucket_id = 'proof');

drop policy if exists proof_upload on storage.objects;
create policy proof_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proof' and public.is_staff());

drop policy if exists proof_delete on storage.objects;
create policy proof_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'proof' and public.staff_rank(public.my_role()) >= public.staff_rank('Admin'));
