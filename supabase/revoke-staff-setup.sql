-- ============================================================
-- Instellar Panel - REVOKE STAFF ACCESS
-- Paste into the Supabase SQL editor and RUN. Safe to run again.
--
-- Adds revoke_staff(uuid): removes the staff row AND the login
-- (auth.users), so the account stops working everywhere at once and
-- the username can be invited again later. Same rule as the existing
-- staff_delete policy: Admin+ (rank 7) only, the Owner can not be
-- revoked, and you can not revoke yourself.
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
