-- ============================================================
-- Instellar: THE PUNISHMENT LEDGER (what the game server actually did)
-- Paste into the Supabase SQL editor and RUN, after
-- punishment-lookup-setup.sql. Safe to run again.
--
-- WHY THIS TABLE EXISTS
-- 'mod_actions' is a QUEUE: a row is there because somebody clicked
-- Ban in the panel, and it carries a status, a staff member and an
-- approval workflow. It is not a record of what happened -- a ban a
-- staff member typed in game with /ban never appears in it at all.
-- Everything reading punishments read that queue, so instellar.net/
-- punishment reported "clean record" for players who were banned,
-- and the panel's own player record agreed with it.
--
-- 'punishments' is the ledger. The Instellar1 plugin publishes every
-- punishment it records into it -- typed in game, queued from the
-- panel, or imported -- and republishes a row when it is unbanned or
-- expires. mod_actions keeps doing its own job unchanged.
--
-- WHO WRITES IT
-- Only the game server, with the service role key, which bypasses
-- RLS. There is no insert, update or delete policy here on purpose:
-- the panel must not be able to write the record of what the server
-- did, or the two can disagree and nothing can say which is right.
--
-- THE PRIMARY KEY IS THE POINT
-- (server, public_id) -- the plugin's own 8-character ban id, the one
-- on the disconnect screen and in /check #id. The plugin upserts on
-- it, so a retry after a timeout, a restart mid-batch and a full
-- backfill of an existing history all land on the same row. Without
-- it a re-sync would double every number this page prints.
-- ============================================================

-- 1) The ledger --------------------------------------------------
create table if not exists public.punishments (
  public_id      text        not null,
  server         text        not null default 'instellar1'
                             check (server in ('instellar1','instellar2')),
  -- the plugin's own PunishType labels, lower case, never renamed
  type           text        not null
                             check (type in ('ban','ipban','blacklist','mute','kick','warn')),
  player_name    text,
  player_uuid    uuid,
  reason         text        not null,
  staff_name     text        not null,
  created_at     timestamptz not null,
  expires_at     timestamptz,             -- null = permanent
  active         boolean     not null,    -- false once revoked or swept as expired
  silent         boolean     not null default false,
  wiped          boolean     not null default false,
  revoked_at     timestamptz,             -- null = never lifted
  revoked_by     text,
  revoked_reason text,
  synced_at      timestamptz not null default now(),
  primary key (server, public_id)
);

-- There is deliberately no 'ip' column. This table is read by a public
-- page through lookup_punishments(), an address is personal data, and
-- the plugin never sends one. Do not add it.

create index if not exists punishments_name
  on public.punishments (lower(player_name));
create index if not exists punishments_active
  on public.punishments (server, active, type);
create index if not exists punishments_created
  on public.punishments (created_at desc);

alter table public.punishments enable row level security;

-- Staff read the whole ledger; the public reaches it only through the
-- security-definer function below, which filters what it may show.
drop policy if exists punishments_select on public.punishments;
create policy punishments_select on public.punishments
  for select to authenticated using (public.is_staff());

do $$ begin
  alter publication supabase_realtime add table public.punishments;
exception when duplicate_object then null; end $$;

-- 2) The public lookup, now reading the ledger --------------------
-- Same JSON shape as before, so instellar.net/punishment needs no
-- change: { blocked, name, warns, bans, lifted, servers[], entries[] }
-- with entries of { id, type, reason, duration, server, at, lifted_at }.
--
-- Three things got simpler by moving off mod_actions:
--
--  * The ban-to-unban pairing CTE is gone. It inferred which unban
--    lifted which ban from created_at ordering, because the queue had
--    no other way to know. The ledger carries revoked_at on the ban
--    itself, which is not an inference.
--  * A silent punishment is excluded. Silent means the server did not
--    announce it; publishing it here would undo the reason it was
--    silent.
--  * A wipe is the 'wiped' flag rather than its own type, and is still
--    reported to the page as 'Wipeban' so its "account wiped" copy
--    keeps rendering.
--
-- 'bans' counts how many times somebody has been banned and not had it
-- lifted -- an expired tempban still counts, exactly as it did before.
-- Mutes and kicks are never returned, and neither is a staff name.
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
    with matched_uuids as (
      select distinct player_uuid
      from punishments
      where lower(player_name) = n and player_uuid is not null
    ),
    visible as (
      select public_id,
             case when type = 'warn' then 'Warn'
                  when wiped then 'Wipeban'
                  else 'Ban' end as kind,
             reason, server, player_name, player_uuid, created_at, expires_at, revoked_at,
             case
               when revoked_at is not null then 'lifted'
               when active and (expires_at is null or expires_at > now()) then 'active'
               else 'expired'
             end as state,
             case
               when expires_at is null then 'Permanent'
               else (
                 with span as (
                   select greatest(0, floor(extract(epoch from (expires_at - created_at))))::bigint as seconds
                 )
                 select case
                   when seconds >= 86400 then (seconds / 86400)::text || ' ' || case when seconds / 86400 = 1 then 'day' else 'days' end
                   when seconds >= 3600 then (seconds / 3600)::text || ' ' || case when seconds / 3600 = 1 then 'hour' else 'hours' end
                   when seconds >= 60 then (seconds / 60)::text || ' ' || case when seconds / 60 = 1 then 'minute' else 'minutes' end
                   else greatest(1, seconds)::text || ' ' || case when greatest(1, seconds) = 1 then 'second' else 'seconds' end
                 end
                 from span
               )
             end as duration
      from punishments
      where not silent
        and type in ('ban', 'ipban', 'blacklist', 'warn')
        and (
          lower(player_name) = n
          or (player_uuid is not null and player_uuid in (select player_uuid from matched_uuids))
        )
    )
    select json_build_object(
      'blocked', false,
      'name', coalesce((select player_name from visible order by created_at desc limit 1), trim(p_name)),
      'warns',  (select count(*) from visible where kind = 'Warn'),
      'bans',   (select count(*) from visible where kind <> 'Warn' and revoked_at is null),
      'lifted', (select count(*) from visible where kind <> 'Warn' and revoked_at is not null),
      'servers', coalesce((
        select json_agg(json_build_object('server', x.server, 'warns', x.warns, 'bans', x.bans)
                        order by x.server)
        from (
          select server,
                 count(*) filter (where kind = 'Warn')                              as warns,
                 count(*) filter (where kind <> 'Warn' and revoked_at is null)      as bans
          from visible group by server
        ) x
      ), '[]'::json),
      'entries', coalesce((
        select json_agg(json_build_object(
                 'id', e.public_id, 'type', e.kind, 'reason', e.reason,
                 'duration', e.duration, 'server', e.server, 'at', e.created_at,
                 'expires_at', e.expires_at, 'lifted_at', e.revoked_at, 'state', e.state)
               order by e.created_at desc)
        from (select * from visible order by created_at desc limit 100) e
      ), '[]'::json)
    )
  );
end $$;

grant execute on function public.lookup_punishments(text) to anon, authenticated;

-- 3) A staff-facing view of the same ledger -----------------------
-- What the panel's player record and infractions tab read. Unlike the
-- public function this keeps silent punishments, mutes and kicks --
-- the panel is behind a staff login and needs the whole picture --
-- but it still never exposes an address, because none is stored.
create or replace view public.punishments_staff
with (security_invoker = true) as
  select public_id, server, type, player_name, player_uuid, reason, staff_name,
         created_at, expires_at, active, silent, wiped,
         revoked_at, revoked_by, revoked_reason,
         (active and (expires_at is null or expires_at > now())) as in_force
  from public.punishments;

grant select on public.punishments_staff to authenticated;
