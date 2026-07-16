-- ============================================================
-- Instellar — SECURITY PATCH
-- Paste this into the Supabase SQL editor and RUN, AFTER you've
-- already run panel-setup.sql. Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- PART A — fixes to the panel side (mod_actions)
-- ------------------------------------------------------------

-- A1) Permanent-ban rank gate.
-- Before: only duration = 'Permanent' required Admin. A Moderator could
-- send duration = null / garbage and the plugin would ban permanently
-- WITHOUT approval. Now anything that isn't an explicit temporary length
-- counts as permanent and needs Admin (rank 3).
create or replace function public.required_rank(a_type text, a_duration text) returns int
language sql immutable as $$
  select case
    when a_type = 'Unban' then 3
    when a_type = 'Ban' and coalesce(a_duration,'') not in
         ('1 hour','1 day','7 days','30 days') then 3
    when a_type = 'Ban' then 2
    else 1
  end
$$;

-- A2) Only allow real duration values in the first place.
alter table public.mod_actions drop constraint if exists mod_actions_duration_chk;
alter table public.mod_actions add constraint mod_actions_duration_chk
  check (duration is null or duration in
         ('Permanent','1 hour','1 day','7 days','30 days'));

-- A3) retry_action must respect rank (before: any Helper could re-queue
--     ANY failed action, including a permaban/unban).
create or replace function public.retry_action(action_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a mod_actions;
begin
  select * into a from mod_actions where id = action_id;
  if a is null then raise exception 'Action not found'; end if;
  if not is_staff() then raise exception 'Not a staff account'; end if;
  if staff_rank(my_role()) < required_rank(a.type, a.duration) then
    raise exception 'Your role cannot retry this action';
  end if;
  update mod_actions set status = 'Pending', error = null
  where id = action_id and status = 'Failed';
end $$;

-- A4) Stop audit-log spoofing: force by_id / by_name from the logged-in
--     account instead of trusting whatever the browser sent.
create or replace function public.set_action_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.by_id := auth.uid();
  select display_name into new.by_name from staff where id = auth.uid();
  return new;
end $$;

drop trigger if exists mod_actions_author on public.mod_actions;
create trigger mod_actions_author before insert on public.mod_actions
  for each row execute function public.set_action_author();


-- ------------------------------------------------------------
-- PART B — lock down the PUBLIC form tables (most important)
-- The ban-appeal / staff-application forms only INSERT. With RLS off,
-- anyone with the public key can READ every submission. This turns RLS
-- on and allows ONLY: anonymous inserts + staff reads. No public reads.
-- ------------------------------------------------------------

alter table public.ban_appeals        enable row level security;
alter table public.staff_applications enable row level security;

drop policy if exists appeals_insert on public.ban_appeals;
create policy appeals_insert on public.ban_appeals
  for insert to anon, authenticated with check (true);

drop policy if exists apps_insert on public.staff_applications;
create policy apps_insert on public.staff_applications
  for insert to anon, authenticated with check (true);

drop policy if exists appeals_select on public.ban_appeals;
create policy appeals_select on public.ban_appeals
  for select to authenticated using (public.is_staff());

drop policy if exists apps_select on public.staff_applications;
create policy apps_select on public.staff_applications
  for select to authenticated using (public.is_staff());

-- (No update/delete policies = only the server's service key can edit or
--  delete submissions. That's what you want.)
