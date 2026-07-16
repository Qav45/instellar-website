-- ============================================================
-- Instellar — TWO SERVERS UPGRADE (Instellar 1 + Instellar 2)
-- Paste into the Supabase SQL editor and RUN, after
-- panel-setup.sql, security-patch.sql and panel-upgrade.sql.
-- Safe to run again.
--
-- Adds a "server" column to every panel table so Instellar 1
-- and Instellar 2 have completely separate bans, audit logs,
-- staff teams, staff logs, guides and player notes.
-- All EXISTING rows automatically become Instellar 1.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array['staff','mod_actions','staff_logs','guides','player_notes'] loop
    execute format(
      'alter table public.%I add column if not exists server text not null default ''instellar1''', t);
    execute format(
      'alter table public.%I drop constraint if exists %I', t, t || '_server_check');
    execute format(
      'alter table public.%I add constraint %I check (server in (''instellar1'',''instellar2''))',
      t, t || '_server_check');
  end loop;
end $$;

-- Fast lookups for the panel and the server plugin
create index if not exists mod_actions_server_status on public.mod_actions(server, status);
create index if not exists staff_server        on public.staff(server);
create index if not exists staff_logs_server   on public.staff_logs(server);
create index if not exists guides_server       on public.guides(server);
create index if not exists player_notes_server on public.player_notes(server);
