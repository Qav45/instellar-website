-- ============================================================
-- Instellar — ADMIN ANNOUNCEMENTS
-- Paste into the Supabase SQL editor and RUN, after
-- panel-upgrade.sql (and two-servers-upgrade.sql). Safe to run again.
--
-- Powers the "From the administration" box on the panel dashboard.
-- Posting and removing uses the SAME permission as Guides
-- (Owner, or the 'Guides' / 'All permissions' perm) — everyone
-- on staff can read.
-- ============================================================

create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  server text not null default 'instellar1'
    check (server in ('instellar1','instellar2')),
  body text not null,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

drop policy if exists anns_select on public.announcements;
create policy anns_select on public.announcements
  for select to authenticated using (public.is_staff());

drop policy if exists anns_insert on public.announcements;
create policy anns_insert on public.announcements
  for insert to authenticated with check (public.can_edit_guides());

drop policy if exists anns_delete on public.announcements;
create policy anns_delete on public.announcements
  for delete to authenticated using (public.can_edit_guides());

-- Author is stamped server-side, same as guides/notes.
drop trigger if exists announcements_author on public.announcements;
create trigger announcements_author before insert on public.announcements
  for each row execute function public.set_row_author();

create index if not exists announcements_server on public.announcements(server);
