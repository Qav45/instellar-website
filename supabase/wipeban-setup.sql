-- ============================================================
-- Instellar: WIPEBAN FROM THE PANEL
-- Paste into the Supabase SQL editor and RUN, after
-- panel-upgrade.sql and two-servers-upgrade.sql. Safe to run again.
-- Then RE-RUN punishment-lookup-setup.sql (it now counts Wipebans as bans).
--
-- Adds a "Wipeban" action to the panel: a permanent ban whose
-- disconnect screen also says the account was wiped, the same as
-- /wipeban in game. Display only: nothing here deletes player data
-- (that is /wipe on the server, on purpose).
--
-- Permission: only staff with the new 'Wipeban' perm (or Owner /
-- 'All permissions') may submit one, checked HERE, not just in the
-- UI. Rank rule matches a permanent ban: Admin (7) runs it directly,
-- anyone lower with the perm sends it for approval.
--
-- The server plugin (Instellar1) must be rebuilt with the matching
-- PanelActions change so it executes rows of type 'Wipeban'.
-- ============================================================

-- 1) Allow the new type
alter table public.mod_actions drop constraint if exists mod_actions_type_check;
alter table public.mod_actions add constraint mod_actions_type_check
  check (type in ('Ban','Kick','Mute','Warn','Unban','Wipeban'));

-- 2) Rank: same as a permanent ban
create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type = 'Unban' then 7
    when a_type = 'Wipeban' then 7
    when a_type = 'Ban' and coalesce(a_duration,'') not in
         ('1 hour','1 day','7 days','30 days') then 7
    when a_type = 'Ban' then 4
    else 2
  end
$$;

-- 3) Permission, checked server-side on every insert
create or replace function public.can_wipeban() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid()
    and (role = 'Owner' or perms && array['Wipeban','All permissions']))
$$;

create or replace function public.guard_wipeban() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'Wipeban' then
    if not public.can_wipeban() then
      raise exception 'You do not have the Wipeban permission';
    end if;
    new.duration := 'Permanent';
  end if;
  return new;
end $$;

drop trigger if exists mod_actions_wipeban on public.mod_actions;
create trigger mod_actions_wipeban before insert on public.mod_actions
  for each row execute function public.guard_wipeban();
