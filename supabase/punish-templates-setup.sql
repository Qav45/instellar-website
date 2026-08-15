-- ============================================================
-- Instellar: PUNISHMENT TEMPLATES
-- Paste into the Supabase SQL editor and RUN, after
-- panel-upgrade.sql, two-servers-upgrade.sql, wipeban-setup.sql and
-- punishment-lookup-setup.sql. Safe to run again.
--
-- The panel ships the staff punishment guidelines as built-in ladders
-- (Spamming: 30m -> 3h -> 1d -> 3d -> 7d, Cheating: 7d -> 14d -> 30d
-- -> Perm, ...). This file adds the shared table for CUSTOM templates
-- staff can add on top, and relaxes the ban-duration rank rule so the
-- ladder durations ("14 days", "3 hours") are accepted.
--
-- Who may add a template is checked HERE, not just in the UI:
--   * the 'Warn' / 'Mute' / 'Ban' perm matching the template's type
--     (Owner and 'All permissions' always may),
--   * a Ban template whose steps include Permanent or anything over
--     30 days needs Admin (rank 7) or higher, same as running one.
-- Anyone on staff can read templates. The author or a Server config
-- holder can delete one.
-- ============================================================

-- 1) "7 days" -> 7, "3 hours" -> 0.125, Permanent/blank/unknown -> null
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

-- 2) Rank rule: a ban is Admin-only when it is permanent or longer than
--    30 days, otherwise Moderator (4). Replaces the old fixed whitelist of
--    '1 hour','1 day','7 days','30 days'.
create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type = 'Unban' then 7
    when a_type = 'Wipeban' then 7
    when a_type = 'Ban' and coalesce(public.duration_days(a_duration), 999999) > 30 then 7
    when a_type = 'Ban' then 4
    else 2
  end
$$;

-- 3) The table
create table if not exists public.punish_templates (
  id bigint generated always as identity primary key,
  server text not null default 'instellar1'
    check (server in ('instellar1','instellar2')),
  name text not null check (length(trim(name)) between 1 and 60),
  type text not null check (type in ('Warn','Mute','Ban')),
  steps text[] not null check (cardinality(steps) between 1 and 12),
  note text,
  by_id uuid references public.staff(id) on delete set null,
  by_name text not null,
  created_at timestamptz not null default now()
);
alter table public.punish_templates enable row level security;

-- 4) Permission, checked server-side on every insert
create or replace function public.can_make_template(a_type text, a_steps text[]) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  st text;
  me record;
begin
  select role, perms into me from staff where id = auth.uid();
  if me is null then return false; end if;
  if not (me.role = 'Owner' or me.perms && array[a_type, 'All permissions']) then return false; end if;
  foreach st in array a_steps loop
    if st = 'Warn' then
      if not (me.role = 'Owner' or me.perms && array['Warn', 'All permissions']) then return false; end if;
    elsif st = 'Permanent' or duration_days(st) is null then
      if a_type = 'Warn' then return false; end if;
      if a_type = 'Ban' and staff_rank(me.role) < 7 then return false; end if;
      if st <> 'Permanent' then return false; end if;
    else
      if a_type = 'Warn' then return false; end if;
      if a_type = 'Ban' and duration_days(st) > 30 and staff_rank(me.role) < 7 then return false; end if;
    end if;
  end loop;
  return true;
end $$;

drop policy if exists tpl_select on public.punish_templates;
create policy tpl_select on public.punish_templates
  for select to authenticated using (public.is_staff());

drop policy if exists tpl_insert on public.punish_templates;
create policy tpl_insert on public.punish_templates
  for insert to authenticated
  with check (public.is_staff() and by_id = auth.uid() and public.can_make_template(type, steps));

drop policy if exists tpl_delete on public.punish_templates;
create policy tpl_delete on public.punish_templates
  for delete to authenticated
  using (by_id = auth.uid() or public.can_server_config());

-- Author is stamped server-side, same as guides/notes/announcements.
drop trigger if exists punish_templates_author on public.punish_templates;
create trigger punish_templates_author before insert on public.punish_templates
  for each row execute function public.set_row_author();

create index if not exists punish_templates_server on public.punish_templates(server);

-- Live updates in the panel
do $$ begin
  alter publication supabase_realtime add table public.punish_templates;
exception when duplicate_object then null; end $$;
