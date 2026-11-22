-- Security hardening
--  1. Presenter allow-list: only users listed in app_hosts can create quizzes and
--     run sessions. The very first presenter claims the platform once; after
--     that, other presenters must be added explicitly (see README).
--  2. Finished sessions are only visible to their host and participants
--     (plus a short grace window so a stage display can show the final podium).
--  3. Strip privileges that RLS cannot govern (TRUNCATE / TRIGGER / REFERENCES).
--  4. Prevent listing the image bucket (public URLs keep working).
--  5. Pin search_path on every function.

-- 1. Presenter allow-list ----------------------------------------------------
create table if not exists public.app_hosts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_hosts enable row level security;
revoke all on public.app_hosts from anon, authenticated;

-- Hosts that already created content before this migration keep access.
insert into public.app_hosts (user_id)
select distinct owner_id from public.quizzes
on conflict do nothing;

create or replace function public.is_host_user() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (select 1 from public.app_hosts where user_id = auth.uid())
$$;

-- Status for the signed-in user (used by the presenter area).
create or replace function public.host_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_host', public.is_host_user(),
    'can_claim', not exists (select 1 from public.app_hosts)
                 and auth.uid() is not null
                 and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false)
$$;

-- Is the platform still unclaimed? (Only decides whether to show "create account".)
create or replace function public.host_signup_open() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.app_hosts)
$$;

-- The first non-anonymous user becomes the owner. Serialised with an advisory
-- lock so two simultaneous sign-ups cannot both claim.
create or replace function public.claim_first_host() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('mml_claim_first_host'));
  if exists (select 1 from public.app_hosts) then
    return exists (select 1 from public.app_hosts where user_id = auth.uid());
  end if;
  insert into public.app_hosts (user_id) values (auth.uid());
  return true;
end $$;

revoke execute on function public.host_status(), public.claim_first_host() from public, anon;
grant execute on function public.host_status(), public.claim_first_host() to authenticated;
revoke execute on function public.host_signup_open() from public;
grant execute on function public.host_signup_open() to anon, authenticated;
grant execute on function public.is_host_user() to authenticated;

-- 2. Session visibility ------------------------------------------------------
-- Membership checks go through SECURITY DEFINER helpers so policies on
-- game_sessions and participants never reference each other (no RLS recursion).
create or replace function public.is_session_host(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.game_sessions where id = p_session_id and host_id = auth.uid())
$$;

create or replace function public.is_session_participant(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.participants where session_id = p_session_id and auth_user_id = auth.uid())
$$;

create or replace function public.can_view_session(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.game_sessions s
    where s.id = p_session_id
      and (s.host_id = auth.uid()
           or s.status = 'active'
           or s.finished_at > now() - interval '12 hours'
           or exists (select 1 from public.participants p where p.session_id = s.id and p.auth_user_id = auth.uid())))
$$;

revoke execute on function public.is_session_host(uuid), public.is_session_participant(uuid), public.can_view_session(uuid) from public, anon;
grant execute on function public.is_session_host(uuid), public.is_session_participant(uuid), public.can_view_session(uuid) to authenticated;

drop policy if exists "anyone signed in reads sessions" on public.game_sessions;
drop policy if exists "sessions visible to host, players, and live viewers" on public.game_sessions;
create policy "sessions visible to host, players, and live viewers" on public.game_sessions
  for select to authenticated
  using (
    host_id = auth.uid()
    or status = 'active'
    or finished_at > now() - interval '12 hours'
    or public.is_session_participant(id)
  );

drop policy if exists "anyone signed in reads live counters" on public.session_live;
drop policy if exists "live counters follow session visibility" on public.session_live;
create policy "live counters follow session visibility" on public.session_live
  for select to authenticated
  using (public.can_view_session(session_id));

drop policy if exists "hosts read session questions" on public.session_questions;
create policy "hosts read session questions" on public.session_questions for select to authenticated
  using (public.is_session_host(session_id));

drop policy if exists "hosts and self read participants" on public.participants;
create policy "hosts and self read participants" on public.participants for select to authenticated
  using (auth_user_id = auth.uid() or public.is_session_host(session_id));

drop policy if exists "hosts read answers" on public.submitted_answers;
create policy "hosts read answers" on public.submitted_answers for select to authenticated
  using (public.is_session_host(session_id));

-- 3. Privileges RLS cannot control --------------------------------------------
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- 4. Image bucket: public files are served by URL; listing is not needed.
drop policy if exists "public read quiz images" on storage.objects;

-- 5. Pin search_path on every remaining function --------------------------------
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end $$;
