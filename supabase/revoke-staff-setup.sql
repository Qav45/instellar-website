-- ============================================================
-- Instellar Panel - REVOKE STAFF ACCESS + "only below your rank"
-- (superseded by supervisor-setup.sql, which includes everything here)
-- Paste into the Supabase SQL editor and RUN. Safe to run again
-- (also fine to run again if you already ran the earlier version).
--
-- 1) revoke_staff(uuid): removes the staff row AND the login
--    (auth.users), so the account stops working everywhere at once and
--    the username can be invited again later.
-- 2) Rank rule, enforced in the database for revoke, role/permission
--    edits and invites: Admin+ (rank 7) only, and you can only touch
--    people BELOW your own role. The Owner is the exception (can manage
--    everyone) and can never be revoked. You can not revoke yourself.
-- ============================================================

create or replace function public.revoke_staff(target_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t staff;
begin
  if staff_rank(my_role()) < 7 then raise exception 'Only Admin+ can revoke staff access'; end if;
  if target_id = auth.uid() then raise exception 'You can not revoke your own access'; end if;
  select * into t from staff where id = target_id;
  if t is null then raise exception 'Staff member not found'; end if;
  if t.role = 'Owner' then raise exception 'The Owner account can not be revoked'; end if;
  if my_role() <> 'Owner' and staff_rank(t.role) >= staff_rank(my_role()) then
    raise exception 'You can only revoke staff below your own role';
  end if;

  -- 1) drop panel access (RLS uses is_staff(), so every request they make fails from here on)
  delete from staff where id = target_id;

  -- 2) delete the login itself (kills refresh tokens, frees the username).
  --    Skipped silently if this database does not let functions touch auth.users;
  --    access is already gone either way.
  begin
    delete from auth.users where id = target_id;
  exception when insufficient_privilege then null;
  end;
end $$;

revoke all on function public.revoke_staff(uuid) from public;
grant execute on function public.revoke_staff(uuid) to authenticated;

-- Same "below your own rank" rule for editing roles/permissions,
-- deleting rows and inviting (replaces the panel-upgrade.sql versions).
drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff
  for insert to authenticated
  with check (public.staff_rank(public.my_role()) >= 7
              and (public.my_role() = 'Owner'
                   or public.staff_rank(role) < public.staff_rank(public.my_role())));

drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff
  for update to authenticated
  using (public.staff_rank(public.my_role()) >= 7
         and (public.my_role() = 'Owner'
              or public.staff_rank(role) < public.staff_rank(public.my_role())))
  with check (public.my_role() = 'Owner'
              or public.staff_rank(role) < public.staff_rank(public.my_role()));

drop policy if exists staff_delete on public.staff;
create policy staff_delete on public.staff
  for delete to authenticated
  using (public.staff_rank(public.my_role()) >= 7 and role <> 'Owner'
         and (public.my_role() = 'Owner'
              or public.staff_rank(role) < public.staff_rank(public.my_role())));
