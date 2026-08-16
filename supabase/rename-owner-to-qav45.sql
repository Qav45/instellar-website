-- ============================================================
-- Rename the instellarownership account to qav45 and make it Supervisor.
-- Run supervisor-setup.sql FIRST (it adds the Supervisor role), then this.
-- Login afterwards: username "qav45" (lowercase, the panel lowercases it),
-- same password as before. Log out and back in once, or wait ~15s.
-- ============================================================
do $$
declare uid uuid;
begin
  select id into uid from public.staff where username = 'instellarownership';
  if uid is null then raise exception 'No staff row with username instellarownership'; end if;

  -- panel account
  update public.staff
     set username = 'qav45', display_name = 'Qav45',
         role = 'Supervisor', perms = '{All permissions}'
   where id = uid;

  -- login: the panel signs in with <username>@staff.instellar
  update auth.users
     set email = 'qav45@staff.instellar',
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"email":"qav45@staff.instellar"}'::jsonb
   where id = uid;
  update auth.identities
     set identity_data = identity_data || '{"email":"qav45@staff.instellar"}'::jsonb
   where user_id = uid and provider = 'email';
end $$;

select username, display_name, role, perms from public.staff where username = 'qav45';
