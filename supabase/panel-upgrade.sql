-- ============================================================
-- Instellar — PANEL UPGRADE (roles + logging + guides + notes)
-- Paste into the Supabase SQL editor and RUN, after
-- panel-setup.sql and security-patch.sql. Safe to run again.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Full 10-role ladder (the panel now uses Trainee → Owner,
--    but the DB only allowed Helper/Moderator/Admin/Owner —
--    inviting any other role failed).
-- ------------------------------------------------------------
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('Trainee','Helper','Jr Moderator','Moderator','Sr Moderator',
                  'Jr Admin','Admin','Sr Admin','Management','Owner'));

create or replace function public.staff_rank(r text) returns int
language sql immutable as $$
  select case r
    when 'Trainee' then 1  when 'Helper' then 2  when 'Jr Moderator' then 3
    when 'Moderator' then 4 when 'Sr Moderator' then 5 when 'Jr Admin' then 6
    when 'Admin' then 7    when 'Sr Admin' then 8 when 'Management' then 9
    when 'Owner' then 10 else 0 end
$$;

-- Same thresholds as the panel UI, on the new scale:
-- Unban / permanent ban -> Admin (7), temp ban -> Moderator (4), rest -> Helper (2)
create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type = 'Unban' then 7
    when a_type = 'Ban' and coalesce(a_duration,'') not in
         ('1 hour','1 day','7 days','30 days') then 7
    when a_type = 'Ban' then 4
    else 2
  end
$$;

-- Staff management now requires Admin (rank 7) on the new scale
drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff
  for insert to authenticated
  with check (public.staff_rank(public.my_role()) >= 7
              and (role <> 'Owner' or public.my_role() = 'Owner'));

drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff
  for update to authenticated
  using (public.staff_rank(public.my_role()) >= 7)
  with check (role <> 'Owner' or public.my_role() = 'Owner');

drop policy if exists staff_delete on public.staff;
create policy staff_delete on public.staff
  for delete to authenticated
  using (public.staff_rank(public.my_role()) >= 7 and role <> 'Owner');

-- ------------------------------------------------------------
-- 2) Shared author trigger (forces by_id / by_name from the
--    logged-in account on every insert — no spoofing)
-- ------------------------------------------------------------
create or replace function public.set_row_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.by_id := auth.uid();
  select display_name into new.by_name from staff where id = auth.uid();
  return new;
end $$;

-- ------------------------------------------------------------
-- 3) Staff activity logs (the "Logging" tab)
-- ------------------------------------------------------------
create table if not exists public.staff_logs (
  id bigint generated always as identity primary key,
  what text not null,
  why text not null,
  after text not null,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  status text not null default 'Pending' check (status in ('Pending','Approved')),
  created_at timestamptz not null default now()
);
alter table public.staff_logs enable row level security;

drop policy if exists logs_select on public.staff_logs;
create policy logs_select on public.staff_logs
  for select to authenticated using (public.is_staff());

drop policy if exists logs_insert on public.staff_logs;
create policy logs_insert on public.staff_logs
  for insert to authenticated
  with check (public.is_staff() and status = 'Pending');

-- Only the Owner account approves logs
drop policy if exists logs_update on public.staff_logs;
create policy logs_update on public.staff_logs
  for update to authenticated
  using (public.my_role() = 'Owner')
  with check (public.my_role() = 'Owner');

drop trigger if exists staff_logs_author on public.staff_logs;
create trigger staff_logs_author before insert on public.staff_logs
  for each row execute function public.set_row_author();

-- ------------------------------------------------------------
-- 4) Guides (the "Guides" tab)
-- ------------------------------------------------------------
create table if not exists public.guides (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  created_at timestamptz not null default now()
);
alter table public.guides enable row level security;

create or replace function public.can_edit_guides() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid()
    and (role = 'Owner' or perms && array['Guides','All permissions']))
$$;

drop policy if exists guides_select on public.guides;
create policy guides_select on public.guides
  for select to authenticated using (public.is_staff());

drop policy if exists guides_insert on public.guides;
create policy guides_insert on public.guides
  for insert to authenticated with check (public.can_edit_guides());

drop policy if exists guides_delete on public.guides;
create policy guides_delete on public.guides
  for delete to authenticated using (public.can_edit_guides());

drop trigger if exists guides_author on public.guides;
create trigger guides_author before insert on public.guides
  for each row execute function public.set_row_author();

-- ------------------------------------------------------------
-- 5) Player staff notes (were browser-only before)
-- ------------------------------------------------------------
create table if not exists public.player_notes (
  id bigint generated always as identity primary key,
  target text not null,
  text text not null,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  created_at timestamptz not null default now()
);
create index if not exists player_notes_target on public.player_notes(target);
alter table public.player_notes enable row level security;

drop policy if exists notes_select on public.player_notes;
create policy notes_select on public.player_notes
  for select to authenticated using (public.is_staff());

drop policy if exists notes_insert on public.player_notes;
create policy notes_insert on public.player_notes
  for insert to authenticated with check (public.is_staff());

drop policy if exists notes_delete on public.player_notes;
create policy notes_delete on public.player_notes
  for delete to authenticated
  using (public.staff_rank(public.my_role()) >= 7);

drop trigger if exists player_notes_author on public.player_notes;
create trigger player_notes_author before insert on public.player_notes
  for each row execute function public.set_row_author();

-- ------------------------------------------------------------
-- 6) Live updates for the new tables
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.staff_logs;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.guides;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.player_notes;
exception when duplicate_object then null; end $$;
