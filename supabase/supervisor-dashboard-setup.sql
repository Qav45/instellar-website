-- ============================================================
-- Instellar Panel - SUPERVISOR DASHBOARD
-- (staff change audit, last-seen pings, optional server status)
-- Paste into the Supabase SQL editor and RUN, after
-- supervisor-setup.sql and protection-setup.sql. Safe to run again.
--
-- What it does
--   1) public.staff_audit: every invite, role change, permission change
--      and removal on the staff table is recorded automatically by a
--      trigger (who did it, old -> new). Nothing in the panel has to
--      remember to write it; SQL run from the dashboard is recorded too
--      (as 'Supabase SQL').
--   2) staff.last_seen_at + ping_staff(): the panel calls ping_staff()
--      on login and every ~10 minutes. Feeds "Last on", "unused for
--      30 days" and "staff active today" on the Supervisor dashboard.
--   3) public.server_status (optional): one row per server with TPS /
--      players online / a heartbeat, written by the plugin with the
--      service key. The panel shows TPS + heartbeat when rows exist and
--      otherwise falls back to player_presence.
--   Everyone on staff can read all of it; nothing here is writable from
--   the browser (only the triggers / functions and the service key).
-- ============================================================

-- 1) Staff change audit -------------------------------------------------
create table if not exists public.staff_audit (
  id bigint generated always as identity primary key,
  staff_id uuid,
  username text,
  display_name text,
  action text not null check (action in ('invited','role_changed','perms_changed','removed')),
  old_role text,
  new_role text,
  old_perms text[],
  new_perms text[],
  server text,
  by_id uuid,
  by_name text not null default 'Supabase SQL',
  created_at timestamptz default now()
);
create index if not exists staff_audit_created_at on public.staff_audit(created_at desc);

alter table public.staff_audit enable row level security;

drop policy if exists staff_audit_select on public.staff_audit;
create policy staff_audit_select on public.staff_audit
  for select to authenticated using (public.is_staff());
-- (no insert/update/delete policies = only the trigger below writes)

-- 2) The trigger that fills it -----------------------------------------------
-- Fires on invite (insert), on role / perms updates and on delete.
-- revoke_staff() deletes rows inside a security definer function, so a
-- revoke from the panel is captured here too, with the revoker's uid.
-- (ping_staff() only touches last_seen_at, so it does not fire this.)
create or replace function public.log_staff_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select display_name into who from staff where id = auth.uid();
  who := coalesce(who, 'Supabase SQL');

  if tg_op = 'INSERT' then
    insert into staff_audit (staff_id, username, display_name, action, new_role, new_perms, server, by_id, by_name)
    values (new.id, new.username, new.display_name, 'invited', new.role, new.perms, new.server, auth.uid(), who);

  elsif tg_op = 'UPDATE' then
    if old.role is not distinct from new.role and old.perms is not distinct from new.perms then
      return null;
    end if;
    insert into staff_audit (staff_id, username, display_name, action,
                             old_role, new_role, old_perms, new_perms, server, by_id, by_name)
    values (new.id, new.username, new.display_name,
            case when old.role is distinct from new.role then 'role_changed' else 'perms_changed' end,
            old.role, new.role, old.perms, new.perms, new.server, auth.uid(), who);

  elsif tg_op = 'DELETE' then
    insert into staff_audit (staff_id, username, display_name, action, old_role, old_perms, server, by_id, by_name)
    values (old.id, old.username, old.display_name, 'removed', old.role, old.perms, old.server, auth.uid(), who);
  end if;

  return null;
end $$;

drop trigger if exists staff_audit_log on public.staff;
create trigger staff_audit_log
  after insert or update of role, perms or delete on public.staff
  for each row execute function public.log_staff_change();

-- 3) Last seen -----------------------------------------------------------------
alter table public.staff add column if not exists last_seen_at timestamptz;

-- The panel calls this on login and every ~10 minutes.
create or replace function public.ping_staff() returns void
language plpgsql security definer set search_path = public as $$
begin
  update staff set last_seen_at = now() where id = auth.uid();
end $$;

revoke all on function public.ping_staff() from public;
grant execute on function public.ping_staff() to authenticated;

-- 4) Server status (optional, written by the plugin) -----------------------------
create table if not exists public.server_status (
  server text primary key check (server in ('instellar1','instellar2')),
  last_seen timestamptz,
  players_online int,
  tps numeric(5,2),
  updated_at timestamptz default now()
);

alter table public.server_status enable row level security;

drop policy if exists server_status_select on public.server_status;
create policy server_status_select on public.server_status
  for select to authenticated using (public.is_staff());
-- (no client writes: only the plugin's service key)

-- FOR THE PLUGIN AUTHOR: every 30 s, with the SERVICE key, upsert one
-- row for your server:
--
--   insert into public.server_status (server, last_seen, players_online, tps, updated_at)
--   values ('instellar1', now(), 12, 19.87, now())
--   on conflict (server) do update
--     set last_seen = excluded.last_seen,
--         players_online = excluded.players_online,
--         tps = excluded.tps,
--         updated_at = excluded.updated_at;
--
-- (or the REST equivalent: POST /rest/v1/server_status with
--  Prefer: resolution=merge-duplicates). Until rows exist the panel
--  falls back to player_presence for the online count.

-- 5) Live updates in the panel ---------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.staff_audit;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.server_status;
exception when duplicate_object then null; end $$;
