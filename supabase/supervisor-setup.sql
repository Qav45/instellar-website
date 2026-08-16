-- ============================================================
-- Instellar Panel - SUPERVISOR role (above Owner)
-- Paste into the Supabase SQL editor and RUN. Safe to run again.
-- Run AFTER revoke-staff-setup.sql (this file replaces its policies
-- and revoke_staff, so running only this one is also fine).
--
-- Supervisor = rank 11, above Owner (10). Rules, all enforced here in
-- the database (the panel can not get around them):
--   * Nobody can invite or promote someone to Supervisor from the panel.
--     Only the SQL at the bottom of this file does that.
--   * Nobody can edit, revoke or delete a Supervisor from the panel,
--     not even another Supervisor. Only SQL here.
--   * A Supervisor can manage / revoke everyone else, INCLUDING the
--     Owner (only a Supervisor can revoke the Owner).
--   * Everyone else keeps the "only below your own rank" rule.
-- ============================================================

-- 1) allow the role -----------------------------------------------
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('Trainee','Helper','Jr Moderator','Moderator','Sr Moderator',
                  'Jr Admin','Admin','Sr Admin','Management','Owner','Supervisor'));

create or replace function public.staff_rank(r text) returns int
language sql immutable as $$
  select case r
    when 'Trainee' then 1  when 'Helper' then 2  when 'Jr Moderator' then 3
    when 'Moderator' then 4 when 'Sr Moderator' then 5 when 'Jr Admin' then 6
    when 'Admin' then 7    when 'Sr Admin' then 8 when 'Management' then 9
    when 'Owner' then 10   when 'Supervisor' then 11 else 0 end
$$;

-- 2) revoke ---------------------------------------------------------
create or replace function public.revoke_staff(target_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t staff;
begin
  if staff_rank(my_role()) < 7 then raise exception 'Only Admin+ can revoke staff access'; end if;
  if target_id = auth.uid() then raise exception 'You can not revoke your own access'; end if;
  select * into t from staff where id = target_id;
  if t is null then raise exception 'Staff member not found'; end if;
  if t.role = 'Supervisor' then raise exception 'A Supervisor can only be removed through Supabase'; end if;
  if t.role = 'Owner' and my_role() <> 'Supervisor' then raise exception 'Only a Supervisor can revoke the Owner'; end if;
  if my_role() <> 'Owner' and staff_rank(t.role) >= staff_rank(my_role()) then
    raise exception 'You can only revoke staff below your own role';
  end if;

  delete from staff where id = target_id;
  begin
    delete from auth.users where id = target_id;
  exception when insufficient_privilege then null;
  end;
end $$;

revoke all on function public.revoke_staff(uuid) from public;
grant execute on function public.revoke_staff(uuid) to authenticated;

-- 3) staff table policies ---------------------------------------------
-- "role" inside using() is the target row's current role;
-- inside with check() it is the role being written.
drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff
  for insert to authenticated
  with check (public.staff_rank(public.my_role()) >= 7
              and role <> 'Supervisor'
              and (public.my_role() = 'Owner'
                   or public.staff_rank(role) < public.staff_rank(public.my_role())));

drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff
  for update to authenticated
  using (public.staff_rank(public.my_role()) >= 7
         and role <> 'Supervisor'
         and (public.my_role() = 'Owner'
              or public.staff_rank(role) < public.staff_rank(public.my_role())))
  with check (role <> 'Supervisor'
              and (public.my_role() = 'Owner'
                   or public.staff_rank(role) < public.staff_rank(public.my_role())));

drop policy if exists staff_delete on public.staff;
create policy staff_delete on public.staff
  for delete to authenticated
  using (public.staff_rank(public.my_role()) >= 7
         and role <> 'Supervisor'
         and (role <> 'Owner' or public.my_role() = 'Supervisor')
         and (public.my_role() = 'Owner'
              or public.staff_rank(role) < public.staff_rank(public.my_role())));

-- 4) things only the Owner could do -> Supervisor too --------------------
drop policy if exists logs_update on public.staff_logs;
create policy logs_update on public.staff_logs
  for update to authenticated
  using (public.my_role() in ('Owner','Supervisor'))
  with check (public.my_role() in ('Owner','Supervisor'));

-- ============================================================
-- HOW TO MAKE SOMEONE SUPERVISOR (this is the ONLY way)
-- 1. Invite them from the panel as any role (or use an existing account).
-- 2. Run this here, with their panel username:
--
--   update public.staff
--      set role = 'Supervisor', perms = '{All permissions}'
--    where username = 'their_username';
--
-- 3. They log out and back in to the panel to pick up the new role.
--
-- To demote a Supervisor:
--   update public.staff set role = 'Owner' where username = 'their_username';
-- To remove a Supervisor completely (login too):
--   delete from auth.users where id = (select id from public.staff where username = 'their_username');
-- ============================================================
