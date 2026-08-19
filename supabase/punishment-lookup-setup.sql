-- ============================================================
-- Instellar: PUBLIC PUNISHMENT LOOKUP + BLACKLIST
-- Paste into the Supabase SQL editor and RUN, after
-- panel-upgrade.sql and two-servers-upgrade.sql. Safe to run again.
--
-- Powers instellar.net/punishment (anyone types a username and
-- sees how many times it was warned / banned, nothing else) and
-- the panel's "Blacklist" tab (usernames that can NOT be looked
-- up on that page). The blacklist is enforced server-side here,
-- so it cannot be bypassed by calling the API directly.
--
-- Blacklist access = Owner, or the 'Server config' /
-- 'All permissions' perm. The blacklist is shared by both servers.
-- ============================================================

-- 1) Who may manage the blacklist ------------------------------
create or replace function public.can_server_config() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid()
    and (role = 'Owner' or perms && array['Server config','All permissions']))
$$;

-- 2) The blacklist -----------------------------------------------
create table if not exists public.punishment_blacklist (
  id bigint generated always as identity primary key,
  name text not null,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists punishment_blacklist_name
  on public.punishment_blacklist (lower(name));
alter table public.punishment_blacklist enable row level security;

drop policy if exists bl_select on public.punishment_blacklist;
create policy bl_select on public.punishment_blacklist
  for select to authenticated using (public.can_server_config());

drop policy if exists bl_insert on public.punishment_blacklist;
create policy bl_insert on public.punishment_blacklist
  for insert to authenticated with check (public.can_server_config());

drop policy if exists bl_delete on public.punishment_blacklist;
create policy bl_delete on public.punishment_blacklist
  for delete to authenticated using (public.can_server_config());

-- Author is stamped server-side, same as guides/notes.
drop trigger if exists punishment_blacklist_author on public.punishment_blacklist;
create trigger punishment_blacklist_author before insert on public.punishment_blacklist
  for each row execute function public.set_row_author();

do $$ begin
  alter publication supabase_realtime add table public.punishment_blacklist;
exception when duplicate_object then null; end $$;

-- 3) Public lookup (called by instellar.net/punishment) ----------
-- Returns only EXECUTED Warns and Bans/Wipebans (each entry's id, type,
-- reason, duration, date, server, and whether it was later lifted by an
-- Unban). Mutes, kicks, staff notes and staff names are never returned.
--
-- Unbans: an Unban does not appear as its own entry. Instead it CLEARS the
-- ban it lifted -- that ban is shown as "Lifted" and stops counting towards
-- the ban total. Bans and unbans are paired newest-first on the same
-- server, so ban -> unban -> ban leaves the newest ban standing.
create or replace function public.lookup_punishments(p_name text) returns json
language plpgsql stable security definer set search_path = public as $$
declare n text := lower(trim(coalesce(p_name, '')));
begin
  if n = '' or length(n) > 32 then
    return json_build_object('error', 'Enter a valid username.');
  end if;
  if exists (select 1 from punishment_blacklist where lower(name) = n) then
    return json_build_object('blocked', true);
  end if;

  return (
    with acted as (
      select id, type, reason, duration, server, created_at
      from mod_actions
      where lower(target) = n and status = 'Executed'
        and type in ('Warn', 'Ban', 'Wipeban', 'Unban')
    ),
    -- every punishment, flagged with the unban that lifted it (if any)
    marked as (
      select a.id, a.type, a.reason, a.duration, a.server, a.created_at,
             case when a.type in ('Ban', 'Wipeban') then (
               select u.created_at from acted u
               where u.type = 'Unban' and u.server = a.server and u.created_at > a.created_at
                 -- pair newest-first: this unban lifts this ban only if there is
                 -- no later ban between them still waiting to be lifted
                 and (select count(*) from acted b
                      where b.type in ('Ban', 'Wipeban') and b.server = a.server
                        and b.created_at > a.created_at and b.created_at < u.created_at)
                   < (select count(*) from acted u2
                      where u2.type = 'Unban' and u2.server = a.server
                        and u2.created_at > a.created_at and u2.created_at < u.created_at) + 1
               order by u.created_at limit 1
             ) end as lifted_at
      from acted a
      where a.type in ('Warn', 'Ban', 'Wipeban')
    )
    select json_build_object(
      'blocked', false,
      'name', coalesce((select target from mod_actions where lower(target) = n order by created_at desc limit 1), trim(p_name)),
      'warns', (select count(*) from marked where type = 'Warn'),
      'bans',  (select count(*) from marked where type in ('Ban', 'Wipeban') and lifted_at is null),
      'lifted', (select count(*) from marked where type in ('Ban', 'Wipeban') and lifted_at is not null),
      'servers', coalesce((
        select json_agg(json_build_object('server', x.server, 'warns', x.warns, 'bans', x.bans) order by x.server)
        from (
          select server,
                 count(*) filter (where type = 'Warn') as warns,
                 count(*) filter (where type in ('Ban', 'Wipeban') and lifted_at is null) as bans
          from marked group by server
        ) x
      ), '[]'::json),
      'entries', coalesce((
        select json_agg(json_build_object(
                 'id', e.id, 'type', e.type, 'reason', e.reason, 'duration', e.duration,
                 'server', e.server, 'at', e.created_at, 'lifted_at', e.lifted_at) order by e.created_at desc)
        from (select * from marked order by created_at desc limit 100) e
      ), '[]'::json)
    )
  );
end $$;

grant execute on function public.lookup_punishments(text) to anon, authenticated;
