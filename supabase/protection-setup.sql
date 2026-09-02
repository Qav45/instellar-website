-- ============================================================
-- Instellar Panel - PROTECTION (players the Supervisor marks as un-bannable)
-- Paste into the Supabase SQL editor and RUN, after
-- supervisor-setup.sql (needs the Supervisor role), wipeban-setup.sql,
-- punish-templates-setup.sql and security-patch.sql. Safe to run again.
-- Run supervisor-dashboard-setup.sql AFTER this one.
--
-- What it does
--   * A Supervisor can put a player name on a protected list (with a
--     reason, an optional expiry and which action types are blocked -
--     Ban and Wipeban always, optionally Mute / Kick / Warn).
--   * The list is SHARED by Instellar 1 and Instellar 2 (there is no
--     server column on purpose: a protected player is protected everywhere).
--   * Every attempt from the panel to punish a protected player is
--     turned into a 'Denied' row whose error starts with 'PROTECTED:'
--     (the panel shows it as "Blocked (protected)") and is logged in
--     public.protection_blocks so the Supervisor sees who tried what.
--     Approving or retrying a queued action against a protected player
--     is refused as well.
--   * Everyone on staff can read the list and the block log; only a
--     Supervisor can add / edit / remove protections.
--
-- FOR THE PLUGIN AUTHOR (in-game commands are NOT blocked yet)
--   The trigger below only covers the panel / queue path (mod_actions).
--   Until the plugin is updated, /ban, /wipeban, /mute, /kick, /warn
--   typed in game still work on protected players. To close that gap,
--   before executing /ban, /wipeban (and /mute, /kick, /warn) run, with
--   the SERVICE key:
--       select public.protection_blocks_type('<name>', 'Ban');   -- or 'Wipeban', 'Mute', 'Kick', 'Warn'
--   If it returns true: refuse the command with the message
--       "This player is protected — ask a Supervisor."
--   and record the attempt so it shows up in the panel:
--       insert into public.protection_blocks (target, type, by_name, server)
--       values ('<name>', 'Ban', '<staff name or "console">', 'instellar1');
--   (target = the player name as typed, type = the command, server =
--   'instellar1' or 'instellar2'.) The check is case-insensitive and
--   ignores expired protections.
--
-- TO DISABLE QUICKLY (keeps the tables, stops blocking):
--   drop trigger if exists mod_actions_protection on public.mod_actions;
-- ============================================================

-- 1) The protected list ------------------------------------------------
-- No server column: shared across Instellar 1 and Instellar 2.
create table if not exists public.protected_players (
  id bigint generated always as identity primary key,
  name text not null check (name ~ '^[A-Za-z0-9_]{1,16}$'),
  name_lc text generated always as (lower(trim(name))) stored,
  reason text not null default '',
  blocks text[] not null default '{Ban,Wipeban}'
    check (blocks <@ array['Ban','Wipeban','Mute','Kick','Warn']
           and blocks @> array['Ban','Wipeban']),
  added_by uuid references public.staff(id) on delete set null,
  added_by_name text not null default '',
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);
-- one protection per name, case-insensitive
create unique index if not exists protected_players_name_lc on public.protected_players(name_lc);

-- 2) Log of blocked attempts ------------------------------------------
create table if not exists public.protection_blocks (
  id bigint generated always as identity primary key,
  target text not null,
  type text not null,
  reason text,
  by_id uuid,
  by_name text not null default '',
  server text,
  created_at timestamptz default now()
);
create index if not exists protection_blocks_created_at on public.protection_blocks(created_at desc);

-- 3) Helpers ------------------------------------------------------------
create or replace function public.is_supervisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and role = 'Supervisor')
$$;

-- true when p_name is currently protected against p_type
-- (case-insensitive, expired protections do not count)
create or replace function public.protection_blocks_type(p_name text, p_type text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from protected_players
     where name_lc = lower(trim(p_name))
       and (expires_at is null or expires_at > now())
       and (case when p_type = 'IpBan' then 'Ban' else p_type end) = any(blocks)
  )
$$;

grant execute on function public.is_supervisor() to authenticated, service_role;
grant execute on function public.protection_blocks_type(text, text) to authenticated, service_role;

-- 4) Row Level Security -------------------------------------------------
alter table public.protected_players enable row level security;
alter table public.protection_blocks  enable row level security;

drop policy if exists protected_select on public.protected_players;
create policy protected_select on public.protected_players
  for select to authenticated using (public.is_staff());

drop policy if exists protected_insert on public.protected_players;
create policy protected_insert on public.protected_players
  for insert to authenticated with check (public.is_supervisor());

drop policy if exists protected_update on public.protected_players;
create policy protected_update on public.protected_players
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

drop policy if exists protected_delete on public.protected_players;
create policy protected_delete on public.protected_players
  for delete to authenticated using (public.is_supervisor());

-- Author is stamped server-side (no spoofing). From the SQL editor
-- (no logged-in user) the given values are kept, name falls back to
-- 'Supabase SQL'.
create or replace function public.set_protection_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if auth.uid() is not null then
    new.added_by := auth.uid();
    select display_name into who from staff where id = auth.uid();
  end if;
  new.added_by_name := coalesce(who, nullif(new.added_by_name, ''), 'Supabase SQL');
  return new;
end $$;

drop trigger if exists protected_players_author on public.protected_players;
create trigger protected_players_author before insert on public.protected_players
  for each row execute function public.set_protection_author();

-- Block log: staff can read, nobody writes from the browser. Rows are
-- written only by the guard trigger below and by the plugin (service key).
drop policy if exists blocks_select on public.protection_blocks;
create policy blocks_select on public.protection_blocks
  for select to authenticated using (public.is_staff());

-- 5) THE GUARD: deny-and-record on mod_actions ---------------------------
-- Runs BEFORE every insert and before every status change. If the row
-- is about to be queued ('Pending') or sent for approval ('Approval')
-- against a protected player: log the attempt, then turn the row into
-- 'Denied' with an error starting with 'PROTECTED:'.
--
-- WHY WE DO NOT RAISE: a raise would roll back the whole statement,
-- including the protection_blocks row we just wrote, so the Supervisor
-- would never see the attempt. Returning a Denied row keeps the log AND
-- the panel shows the row as "Blocked (protected)" (it recognises the
-- 'PROTECTED:' prefix).
--
-- Trigger order: BEFORE triggers fire in name order, so this runs after
-- mod_actions_author and before mod_actions_wipeban. It does not depend
-- on either: the actor is taken from auth.uid() directly (with new.by_name
-- / 'plugin' as fallback when there is no logged-in user). Only corner
-- case: a Wipeban by someone WITHOUT the Wipeban perm on a protected
-- player is still rejected by mod_actions_wipeban (raise), which also
-- rolls back this log row - fine, that person could not wipeban anyway.
create or replace function public.guard_protection() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  why text;
  who text;
begin
  if new.status in ('Pending','Approval')
     and public.protection_blocks_type(new.target, new.type) then
    select reason into why from protected_players
     where name_lc = lower(trim(new.target))
       and (expires_at is null or expires_at > now())
     limit 1;
    select display_name into who from staff where id = auth.uid();

    insert into protection_blocks (target, type, reason, by_id, by_name, server)
    values (new.target, new.type, new.reason, auth.uid(),
            coalesce(who, coalesce(new.by_name, 'plugin')), new.server);

    new.status := 'Denied';
    new.error  := 'PROTECTED: ' || new.target || ' is protected'
                  || case when coalesce(why, '') <> '' then ' (' || why || ')' else '' end
                  || ' - ask a Supervisor.';
  end if;
  return new;
end $$;

drop trigger if exists mod_actions_protection on public.mod_actions;
create trigger mod_actions_protection
  before insert or update of status on public.mod_actions
  for each row execute function public.guard_protection();

-- 6) Let the Denied row through the insert policy ------------------------
-- RLS WITH CHECK is evaluated on the row AFTER the BEFORE triggers ran.
-- The original actions_insert (panel-setup.sql) only accepts the forced
-- 'Pending' / 'Approval' status, so a row the guard turned into 'Denied'
-- would be rejected and the browser would get an RLS error instead of
-- the "Blocked (protected)" row. Same rule as before, plus that one case
-- (only when the target really is protected against that type).
-- (by_id = auth.uid() is kept for compatibility; mod_actions_author
--  overwrites by_id with auth.uid() anyway.)
drop policy if exists actions_insert on public.mod_actions;
create policy actions_insert on public.mod_actions
  for insert to authenticated
  with check (
    public.is_staff()
    and by_id = auth.uid()
    and (
      status = (case when public.staff_rank(public.my_role())
                          >= public.required_rank(type, duration)
                     then 'Pending' else 'Approval' end)
      or (status = 'Denied' and public.protection_blocks_type(target, type))
    )
  );

-- 7) approve / retry refuse protected targets -----------------------------
-- Same bodies as panel-setup.sql (approve_action) and security-patch.sql
-- (rank-checked retry_action), plus the protection check right after
-- loading the row. (deny_action is unchanged: denying is always fine.)
create or replace function public.approve_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a mod_actions;
begin
  select * into a from mod_actions where id = action_id;
  if a is null then raise exception 'Action not found'; end if;
  if public.protection_blocks_type(a.target, a.type) then
    raise exception 'PROTECTED: % is protected - ask a Supervisor.', a.target;
  end if;
  if a.status <> 'Approval' then raise exception 'This action is not awaiting approval'; end if;
  if staff_rank(my_role()) < required_rank(a.type, a.duration) then
    raise exception 'Your role cannot approve this action';
  end if;
  update mod_actions set status = 'Pending' where id = action_id;
end $$;

create or replace function public.retry_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a mod_actions;
begin
  select * into a from mod_actions where id = action_id;
  if a is null then raise exception 'Action not found'; end if;
  if public.protection_blocks_type(a.target, a.type) then
    raise exception 'PROTECTED: % is protected - ask a Supervisor.', a.target;
  end if;
  if not is_staff() then raise exception 'Not a staff account'; end if;
  if staff_rank(my_role()) < required_rank(a.type, a.duration) then
    raise exception 'Your role cannot retry this action';
  end if;
  update mod_actions set status = 'Pending', error = null
  where id = action_id and status = 'Failed';
end $$;

-- 8) Live updates in the panel ---------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.protected_players;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.protection_blocks;
exception when duplicate_object then null; end $$;
