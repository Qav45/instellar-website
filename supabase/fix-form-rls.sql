-- Fix: "new row violates row-level security policy for table staff_applications"
-- Run this in the Supabase SQL editor. Safe to run more than once.
-- It re-creates the public INSERT policies from security-patch.sql Part B
-- (the apply page inserts with the anon key, so anon must be allowed to insert).

alter table public.staff_applications enable row level security;
alter table public.ban_appeals        enable row level security;

grant insert on public.staff_applications to anon, authenticated;
grant insert on public.ban_appeals        to anon, authenticated;

drop policy if exists apps_insert on public.staff_applications;
create policy apps_insert on public.staff_applications
  for insert to anon, authenticated with check (true);

drop policy if exists appeals_insert on public.ban_appeals;
create policy appeals_insert on public.ban_appeals
  for insert to anon, authenticated with check (true);

-- Check: both tables should show an INSERT policy for {anon,authenticated}.
select tablename, policyname, roles, cmd
from pg_policies
where tablename in ('staff_applications', 'ban_appeals')
order by tablename, policyname;
