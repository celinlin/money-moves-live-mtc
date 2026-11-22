-- Participants without Supabase Auth.
--
-- Players no longer need an (anonymous) Supabase account. On join, the server
-- issues a random 244-bit secret token, returned exactly once and stored on the
-- device; only its SHA-256 hash is kept in the database. Every player action
-- presents the token. Benefits:
--   * works with the project's default Auth settings (anonymous sign-ins off);
--   * no Auth rate limit per IP — a whole venue on one Wi-Fi can join at once;
--   * a token only ever grants access to one participant in one session.
-- Stage displays read public session data with the public (anon) key.

alter table public.participants alter column auth_user_id drop not null;
alter table public.participants add column if not exists token_hash text;
create unique index if not exists participants_token_hash_key on public.participants (token_hash);

create or replace function public._hash_token(p_token text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

create or replace function public._new_token() returns text
language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- Resolve a participant from (session, token). Returns null when invalid.
create or replace function public._participant_by_token(p_session_id uuid, p_token text)
returns public.participants language sql stable set search_path = public as $$
  select * from public.participants
  where session_id = p_session_id
    and token_hash = public._hash_token(p_token)
    and p_token is not null and length(p_token) >= 32
$$;

revoke execute on function public._hash_token(text), public._new_token(), public._participant_by_token(uuid, text)
  from public, anon, authenticated;

drop function if exists public.join_session(text, text);
drop function if exists public.player_state(uuid);
drop function if exists public.submit_answer(uuid, int, uuid[]);
drop function if exists public.heartbeat(uuid);

create or replace function public.join_session(p_pin text, p_nickname text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  p public.participants;
  v_nick text := regexp_replace(btrim(coalesce(p_nickname, '')), '\s+', ' ', 'g');
  v_token text;
begin
  select * into s from public.game_sessions where game_pin = btrim(coalesce(p_pin, '')) and status = 'active' for share;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;

  -- Rejoin with the device's token: same participant, same score.
  if p_token is not null then
    p := public._participant_by_token(s.id, p_token);
    if p.id is not null then
      if p.removed then raise exception 'PARTICIPANT_REMOVED' using errcode = 'P0001'; end if;
      update public.participants set last_seen_at = now() where id = p.id;
      return jsonb_build_object('session_id', s.id, 'participant_id', p.id, 'nickname', p.nickname,
                                'token', p_token, 'rejoined', true);
    end if;
  end if;

  if char_length(v_nick) < 1 or char_length(v_nick) > 24 then
    raise exception 'INVALID_NICKNAME' using errcode = 'P0001';
  end if;
  if (select count(*) from public.participants where session_id = s.id) >= 1000 then
    raise exception 'SESSION_FULL' using errcode = 'P0001';
  end if;

  v_token := public._new_token();
  begin
    insert into public.participants (session_id, auth_user_id, nickname, eligible_from_index, token_hash)
    -- Late joiners spectate the question in progress and play from the next one.
    values (s.id, null, v_nick, greatest(s.current_question_index + 1, 0), public._hash_token(v_token))
    returning * into p;
  exception when unique_violation then
    raise exception 'NICKNAME_TAKEN' using errcode = 'P0001';
  end;

  update public.session_live set participants_count = participants_count + 1,
                                 connected_count = connected_count + 1, updated_at = now()
   where session_id = s.id;
  return jsonb_build_object('session_id', s.id, 'participant_id', p.id, 'nickname', p.nickname,
                            'token', v_token, 'rejoined', false);
end $$;

create or replace function public.player_state(p_session_id uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s public.game_sessions;
  p public.participants;
  q public.session_questions;
  a public.submitted_answers;
  total int;
begin
  select * into s from public.game_sessions where id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  p := public._participant_by_token(s.id, p_token);
  if p.id is null then
    return jsonb_build_object('joined', false, 'participants_count',
      (select participants_count from public.session_live where session_id = s.id));
  end if;

  if s.current_question_index >= 0 then
    select * into q from public.session_questions where session_id = s.id and question_index = s.current_question_index;
    select * into a from public.submitted_answers where participant_id = p.id and session_question_id = q.id;
  end if;
  select count(*) into total from public.participants where session_id = s.id and not removed;

  return jsonb_build_object(
    'joined', true,
    'removed', p.removed,
    'state_version', s.state_version,
    'participant', jsonb_build_object(
      'id', p.id, 'nickname', p.nickname, 'total_score', p.total_score, 'rank', p.rank,
      'previous_rank', p.previous_rank, 'correct_count', p.correct_answers_count,
      'eligible_from_index', p.eligible_from_index),
    'participants_count', total,
    'answer', case when a.id is null then null else jsonb_build_object(
      'question_index', a.question_index,
      'selected_option_ids', to_jsonb(a.selected_option_ids),
      'submitted_at', a.submitted_at,
      'is_correct', case when q.revealed then a.is_correct else null end,
      'points', case when q.revealed then a.points_awarded else null end) end
  );
end $$;

create or replace function public.submit_answer(p_session_id uuid, p_question_index int, p_option_ids uuid[], p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  p public.participants;
  q public.session_questions;
  existing public.submitted_answers;
  v_now timestamptz;
  v_duration_ms int;
  v_remaining_ms int;
  v_ids uuid[];
  v_valid int;
  v_correct boolean;
  v_points int := 0;
  inserted_id uuid;
begin
  -- Shared lock: concurrent answers proceed in parallel, but a stage transition
  -- (FOR UPDATE) waits for in-flight answers and vice versa.
  select * into s from public.game_sessions where id = p_session_id for share;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  -- Timestamp taken after acquiring the lock (always before any later closed_at).
  v_now := clock_timestamp();

  p := public._participant_by_token(s.id, p_token);
  if p.id is null or p.removed then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0001'; end if;

  select * into q from public.session_questions where session_id = s.id and question_index = p_question_index;
  if not found then raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001'; end if;

  -- Idempotent: a retried request returns the already-accepted answer.
  select * into existing from public.submitted_answers where participant_id = p.id and session_question_id = q.id;
  if found then
    return jsonb_build_object('accepted', true, 'duplicate', true, 'submitted_at', existing.submitted_at,
                              'selected_option_ids', to_jsonb(existing.selected_option_ids));
  end if;

  if s.current_question_index <> p_question_index then raise exception 'QUESTION_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if s.current_stage = 'QUESTION_PAUSED' then raise exception 'QUESTION_PAUSED' using errcode = 'P0001'; end if;
  if s.current_stage <> 'QUESTION_OPEN' then raise exception 'QUESTION_CLOSED' using errcode = 'P0001'; end if;
  if v_now > s.question_deadline_at + make_interval(secs => public._grace_ms() / 1000.0) then
    raise exception 'QUESTION_CLOSED' using errcode = 'P0001';
  end if;
  if p.eligible_from_index > p_question_index then raise exception 'NOT_ELIGIBLE' using errcode = 'P0001'; end if;

  select array_agg(distinct x) into v_ids from unnest(p_option_ids) x;
  if v_ids is null or cardinality(v_ids) = 0 then raise exception 'INVALID_ANSWER' using errcode = 'P0001'; end if;
  if cardinality(v_ids) > 1 and not q.allow_multiple then raise exception 'INVALID_ANSWER' using errcode = 'P0001'; end if;
  select count(*) into v_valid from jsonb_array_elements(q.options) o where (o->>'id')::uuid = any (v_ids);
  if v_valid <> cardinality(v_ids) then raise exception 'INVALID_ANSWER' using errcode = 'P0001'; end if;

  v_duration_ms := coalesce(q.effective_time_limit_sec, q.time_limit_sec) * 1000;
  v_remaining_ms := greatest(0, least(v_duration_ms,
                     (extract(epoch from (s.question_deadline_at - v_now)) * 1000)::int));

  if q.kind = 'quiz' then
    select coalesce(bool_and((o->>'is_correct')::boolean), false) into v_correct
      from jsonb_array_elements(q.options) o where (o->>'id')::uuid = v_ids[1];
    v_points := case when v_correct then public.compute_points(v_remaining_ms, v_duration_ms) else 0 end;
  else
    v_correct := null;
  end if;

  insert into public.submitted_answers
    (session_id, participant_id, session_question_id, question_index, selected_option_ids, submitted_at, response_time_ms, is_correct, points_awarded)
  values (s.id, p.id, q.id, p_question_index, v_ids, v_now, v_duration_ms - v_remaining_ms, v_correct, v_points)
  on conflict (participant_id, session_question_id) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    update public.session_live set answers_count = answers_count + 1, updated_at = now() where session_id = s.id;
    update public.participants set last_seen_at = now() where id = p.id;
  end if;

  -- Correctness / points are deliberately NOT returned before the reveal.
  return jsonb_build_object('accepted', true, 'duplicate', inserted_id is null, 'submitted_at', v_now,
                            'selected_option_ids', to_jsonb(v_ids));
end $$;

create or replace function public.heartbeat(p_session_id uuid, p_token text)
returns timestamptz language plpgsql security definer set search_path = public as $$
begin
  update public.participants set last_seen_at = now()
   where session_id = p_session_id and token_hash = public._hash_token(p_token)
     and p_token is not null and last_seen_at < now() - interval '5 seconds';
  return clock_timestamp();
end $$;

-- Time-driven transitions and presence counts are safe for anyone to request:
-- the server only acts when its own clock / data says the transition is due.
create or replace function public.tick_session(p_session_id uuid)
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  live public.session_live;
  due boolean;
begin
  select * into s from public.game_sessions where id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into live from public.session_live where session_id = s.id;

  due := (s.current_stage = 'STARTING' and s.stage_ends_at <= now())
      or (s.current_stage = 'QUESTION_OPEN' and (
            now() >= s.question_deadline_at + make_interval(secs => public._grace_ms() / 1000.0)
         or (s.auto_close_when_all_answered and live.eligible_count > 0 and live.answers_count >= live.eligible_count)));
  if not due then return s; end if;

  select * into s from public.game_sessions where id = p_session_id for update;
  select * into live from public.session_live where session_id = s.id;
  if s.current_stage = 'STARTING' and s.stage_ends_at <= now() then
    s := public._open_question(s, 0);
    return public._commit(s);
  elsif s.current_stage = 'QUESTION_OPEN' and (
            now() >= s.question_deadline_at + make_interval(secs => public._grace_ms() / 1000.0)
         or (s.auto_close_when_all_answered and live.eligible_count > 0 and live.answers_count >= live.eligible_count)) then
    s := public._close_current(s);
    return public._commit(s);
  end if;
  return s;
end $$;

create or replace function public.refresh_presence(p_session_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from public.participants
   where session_id = p_session_id and not removed and last_seen_at > now() - interval '35 seconds';
  update public.session_live set connected_count = n, updated_at = now()
   where session_id = p_session_id and connected_count is distinct from n;
  return n;
end $$;

-- Public (anon key) access: only what a phone or a projector needs.
revoke execute on function public.join_session(text, text, text), public.player_state(uuid, text),
  public.submit_answer(uuid, int, uuid[], text), public.heartbeat(uuid, text) from public;
grant execute on function
  public.join_session(text, text, text), public.player_state(uuid, text),
  public.submit_answer(uuid, int, uuid[], text), public.heartbeat(uuid, text),
  public.tick_session(uuid), public.refresh_presence(uuid), public.lookup_session(text), public.server_time()
to anon, authenticated;

-- Read-only public view of live sessions for phones and the stage display
-- (public_state never contains future questions or unrevealed answers).
grant select on public.game_sessions, public.session_live to anon;
drop policy if exists "public reads live sessions" on public.game_sessions;
create policy "public reads live sessions" on public.game_sessions for select to anon
  using (status = 'active' or finished_at > now() - interval '12 hours');
drop policy if exists "public reads live counters" on public.session_live;
create policy "public reads live counters" on public.session_live for select to anon
  using (exists (select 1 from public.game_sessions s
                 where s.id = session_id and (s.status = 'active' or s.finished_at > now() - interval '12 hours')));
