-- ============================================================
-- Instellar Moderation Panel — Supabase setup
-- Run this ONCE in the SQL editor of the SAME Supabase project
-- your ban-appeal / staff-application forms already use.
-- ============================================================

-- 1) Staff accounts ------------------------------------------
create table if not exists public.staff (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  role text not null check (role in ('Helper','Moderator','Admin','Owner')),
  perms text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- 2) Moderation actions / audit log --------------------------
create table if not exists public.mod_actions (
  id bigint generated always as identity primary key,
  type text not null check (type in ('Ban','Kick','Mute','Warn','Unban')),
  target text not null,
  reason text not null,
  duration text,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  status text not null default 'Pending'
    check (status in ('Pending','Approval','Executed','Failed','Denied')),
  error text,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

-- 3) Role helpers ---------------------------------------------
create or replace function public.staff_rank(r text) returns int
language sql immutable as $$
  select case r when 'Helper' then 1 when 'Moderator' then 2
                when 'Admin' then 3 when 'Owner' then 4 else 0 end
$$;

-- Which rank an action requires (mirrors the panel UI)
create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type = 'Unban' then 3
    when a_type = 'Ban' and a_duration = 'Permanent' then 3
    when a_type = 'Ban' then 2
    else 1
  end
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from staff where id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid())
$$;

-- 4) Row Level Security ---------------------------------------
alter table public.staff enable row level security;
alter table public.mod_actions enable row level security;

drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff
  for select to authenticated using (public.is_staff());

drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff
  for insert to authenticated
  with check (public.staff_rank(public.my_role()) >= 3
              and (role <> 'Owner' or public.my_role() = 'Owner'));

drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff
  for update to authenticated
  using (public.staff_rank(public.my_role()) >= 3)
  with check (role <> 'Owner' or public.my_role() = 'Owner');

drop policy if exists staff_delete on public.staff;
create policy staff_delete on public.staff
  for delete to authenticated
  using (public.staff_rank(public.my_role()) >= 3 and role <> 'Owner');

drop policy if exists actions_select on public.mod_actions;
create policy actions_select on public.mod_actions
  for select to authenticated using (public.is_staff());

-- Staff can create actions, but the status is FORCED server-side:
-- high enough rank -> 'Pending' (queued for the server plugin),
-- otherwise        -> 'Approval' (needs a higher role to approve).
drop policy if exists actions_insert on public.mod_actions;
create policy actions_insert on public.mod_actions
  for insert to authenticated
  with check (
    public.is_staff()
    and by_id = auth.uid()
    and status = (case when public.staff_rank(public.my_role())
                            >= public.required_rank(type, duration)
                       then 'Pending' else 'Approval' end)
  );

-- No direct updates from the browser: all status changes go
-- through the functions below (or the server plugin's service key).

-- 5) Approve / deny / retry (rank-checked, server-side) --------
create or replace function public.approve_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a mod_actions;
begin
  select * into a from mod_actions where id = action_id;
  if a is null then raise exception 'Action not found'; end if;
  if a.status <> 'Approval' then raise exception 'This action is not awaiting approval'; end if;
  if staff_rank(my_role()) < required_rank(a.type, a.duration) then
    raise exception 'Your role cannot approve this action';
  end if;
  update mod_actions set status = 'Pending' where id = action_id;
end $$;

create or replace function public.deny_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a mod_actions;
begin
  select * into a from mod_actions where id = action_id;
  if a is null then raise exception 'Action not found'; end if;
  if a.status <> 'Approval' then raise exception 'This action is not awaiting approval'; end if;
  if staff_rank(my_role()) < required_rank(a.type, a.duration) then
    raise exception 'Your role cannot deny this action';
  end if;
  update mod_actions set status = 'Denied' where id = action_id;
end $$;

create or replace function public.retry_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Not a staff account'; end if;
  update mod_actions set status = 'Pending', error = null
  where id = action_id and status = 'Failed';
end $$;

-- 6) Live updates in the panel ---------------------------------
-- (If either line errors with "already member of publication", ignore it.)
alter publication supabase_realtime add table public.mod_actions;
alter publication supabase_realtime add table public.staff;

-- 7) Bootstrap the first Owner ---------------------------------
-- a) Dashboard -> Authentication -> Users -> "Add user":
--       email:    instellarownership@staff.instellar
--       password: (choose a strong one)
--       check "Auto Confirm User"
-- b) Then run this (uncomment first):
--
-- insert into public.staff (id, username, display_name, role, perms)
-- select id, 'instellarownership', 'Instellar Ownership', 'Owner', array['All permissions']
-- from auth.users where email = 'instellarownership@staff.instellar'
-- on conflict (id) do nothing;
