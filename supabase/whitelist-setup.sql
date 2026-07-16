-- Whitelist requests for Instellar 2
-- Run this WHOLE file in the Supabase SQL editor (it is safe to re-run).
-- Needs the pg_net extension: Database → Extensions → enable "pg_net" first.

create table if not exists public.whitelist_requests (
  id bigint generated always as identity primary key,
  minecraft_username text not null,
  discord_username text not null,
  dm_username text not null,
  why_join text not null default '',
  found_us text not null default '',
  server text not null default 'Instellar 2',
  status text not null default 'Pending',
  ip text,
  created_at timestamptz not null default now()
);

alter table public.whitelist_requests add column if not exists ip text;

alter table public.whitelist_requests enable row level security;

-- Anyone can submit from the website
drop policy if exists wl_insert on public.whitelist_requests;
create policy wl_insert on public.whitelist_requests
  for insert to anon, authenticated with check (true);

-- Only staff can read them
drop policy if exists wl_select on public.whitelist_requests;
create policy wl_select on public.whitelist_requests
  for select to authenticated using (public.is_staff());

-- ------------------------------------------------------------
-- Safety: one request per IP (and per username), enforced
-- SERVER-side. The IP comes from the request headers, so it
-- cannot be spoofed by the browser.
-- ------------------------------------------------------------
create or replace function public.guard_whitelist_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare req_ip text;
begin
  begin
    req_ip := split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1);
  exception when others then req_ip := null;
  end;
  new.ip := req_ip;
  new.status := 'Pending';
  if req_ip is not null and exists (
    select 1 from whitelist_requests w where w.ip = req_ip
  ) then
    raise exception 'You have already sent a whitelist request.';
  end if;
  if exists (
    select 1 from whitelist_requests w
    where lower(w.minecraft_username) = lower(new.minecraft_username)
       or lower(w.discord_username) = lower(new.discord_username)
  ) then
    raise exception 'You have already sent a whitelist request.';
  end if;
  return new;
end $$;

drop trigger if exists whitelist_request_guard on public.whitelist_requests;
create trigger whitelist_request_guard before insert on public.whitelist_requests
  for each row execute function public.guard_whitelist_request();

-- ------------------------------------------------------------
-- Discord notification (server-side, webhook never in browser)
-- ------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.notify_whitelist_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'YOUR_DISCORD_WEBHOOK_URL',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'embeds', jsonb_build_array(jsonb_build_object(
        'title', '⭐ New Whitelist Request',
        'color', 10181046,
        'fields', jsonb_build_array(
          jsonb_build_object('name', 'Minecraft username', 'value', new.minecraft_username, 'inline', true),
          jsonb_build_object('name', 'Discord username', 'value', new.discord_username, 'inline', true),
          jsonb_build_object('name', 'DM this user', 'value', new.dm_username, 'inline', true),
          jsonb_build_object('name', 'Server', 'value', new.server, 'inline', true),
          jsonb_build_object('name', 'Why join', 'value', left(new.why_join, 1024), 'inline', false),
          jsonb_build_object('name', 'Found us via', 'value', coalesce(nullif(new.found_us, ''), '—'), 'inline', true)
        )
      ))
    )
  );
  return new;
end $$;

drop trigger if exists whitelist_request_notify on public.whitelist_requests;
create trigger whitelist_request_notify after insert on public.whitelist_requests
  for each row execute function public.notify_whitelist_request();
