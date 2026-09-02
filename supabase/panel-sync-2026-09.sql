-- ============================================================
-- Instellar panel sync patch, September 2026
-- Operator: paste this whole file into the Supabase SQL editor once
-- and run it. It is idempotent and safe to re-run.
-- ============================================================

-- One duration grammar for rank rules, template validation and CHECK constraints.
create or replace function public.duration_days(d text) returns numeric
language sql immutable as $$
  select case
    when d is null then null
    when lower(trim(d)) !~ '^[0-9]+\s*(second|minute|hour|day|week|month|year)s?$' then null
    else (regexp_match(lower(trim(d)), '^([0-9]+)'))[1]::numeric *
         case (regexp_match(lower(trim(d)), '(second|minute|hour|day|week|month|year)'))[1]
           when 'second' then 1.0/86400 when 'minute' then 1.0/1440 when 'hour' then 1.0/24
           when 'day' then 1 when 'week' then 7 when 'month' then 30 else 365 end
  end
$$;

create or replace function public.valid_panel_duration(d text) returns boolean
language sql immutable as $$
  select d is null or lower(trim(d)) = 'permanent' or public.duration_days(d) is not null
$$;

create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type in ('Unban','Unmute','Wipeban') then 7
    when a_type in ('Ban','IpBan') and coalesce(public.duration_days(a_duration), 999999) > 30 then 7
    when a_type in ('Ban','IpBan') then 4
    else 2
  end
$$;

alter table public.mod_actions drop constraint if exists mod_actions_type_check;
alter table public.mod_actions add constraint mod_actions_type_check
  check (type in ('Ban','IpBan','Kick','Mute','Warn','Unban','Unmute','Wipeban'));

alter table public.mod_actions drop constraint if exists mod_actions_duration_chk;
alter table public.mod_actions add constraint mod_actions_duration_chk
  check (public.valid_panel_duration(duration));

-- A protection that blocks 'Ban' also blocks the new IpBan action.
create or replace function public.protection_blocks_type(p_name text, p_type text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from protected_players
     where name_lc = lower(trim(p_name))
       and (expires_at is null or expires_at > now())
       and (case when p_type = 'IpBan' then 'Ban' else p_type end) = any(blocks)
  )
$$;

-- Presence published by the plugin's PanelClient upsert on_conflict=uuid,server.
create table if not exists public.player_presence (
  uuid text not null,
  server text not null default 'instellar1'
    check (server in ('instellar1','instellar2')),
  name text not null,
  last_seen timestamptz not null default now(),
  unique (uuid, server)
);
create index if not exists player_presence_server_seen on public.player_presence(server, last_seen desc);
alter table public.player_presence enable row level security;

drop policy if exists player_presence_select on public.player_presence;
create policy player_presence_select on public.player_presence
  for select to authenticated using (public.is_staff());

do $$ begin
  alter publication supabase_realtime add table public.player_presence;
exception when duplicate_object then null; end $$;

-- Public lookup backed by the punishment ledger, not the panel queue.
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
                 count(*) filter (where kind = 'Warn') as warns,
                 count(*) filter (where kind <> 'Warn' and revoked_at is null) as bans
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

create or replace view public.punishments_staff
with (security_invoker = true) as
  select public_id, server, type, player_name, player_uuid, reason, staff_name,
         created_at, expires_at, active, silent, wiped,
         revoked_at, revoked_by, revoked_reason,
         (active and (expires_at is null or expires_at > now())) as in_force
  from public.punishments;

grant select on public.punishments_staff to authenticated;
