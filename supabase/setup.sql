-- Money Moves Live — complete database setup (all migrations in order).
-- Only needed WITHOUT the Vercel integration (which applies migrations at build time).
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

-- ===== supabase/migrations/20261122000100_schema.sql =====
-- Money Moves Live — core schema
-- All game mutations go through SECURITY DEFINER functions (see next migration).
-- Tables only expose read access through Row Level Security.

create extension if not exists pgcrypto with schema extensions;

create type public.game_stage as enum (
  'LOBBY', 'STARTING', 'QUESTION_OPEN', 'QUESTION_PAUSED',
  'QUESTION_CLOSED', 'ANSWER_REVEAL', 'LEADERBOARD', 'FINISHED'
);

-- quiz  = one correct answer, scored, counts for the leaderboard
-- poll  = opinion question (sondage), never scored, single or multiple choice
create type public.question_kind as enum ('quiz', 'poll');

-- ---------------------------------------------------------------------------
-- Quiz library
-- ---------------------------------------------------------------------------
create table public.host_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  samples_seeded_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  show_leaderboard boolean not null default true,
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quizzes_owner_idx on public.quizzes (owner_id, updated_at desc);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  order_index int not null check (order_index >= 0),
  kind public.question_kind not null default 'quiz',
  allow_multiple boolean not null default false,
  question_text text not null check (char_length(question_text) between 1 and 300),
  image_url text check (image_url is null or char_length(image_url) <= 2000),
  time_limit_sec int not null default 20 check (time_limit_sec between 5 and 300),
  explanation text check (explanation is null or char_length(explanation) <= 600),
  created_at timestamptz not null default now(),
  constraint questions_order_unique unique (quiz_id, order_index),
  constraint questions_quiz_single check (not (kind = 'quiz' and allow_multiple))
);

create table public.answer_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  position smallint not null check (position between 0 and 7),
  answer_text text not null check (char_length(answer_text) between 1 and 120),
  is_correct boolean not null default false,
  constraint answer_options_position_unique unique (question_id, position)
);

-- ---------------------------------------------------------------------------
-- Live sessions
-- ---------------------------------------------------------------------------
create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid references public.quizzes (id) on delete set null,
  host_id uuid not null references auth.users (id) on delete cascade,
  game_pin text not null check (game_pin ~ '^[0-9]{6}$'),
  quiz_title text not null,
  show_leaderboard boolean not null default true,
  status text not null default 'active' check (status in ('active', 'finished')),
  current_stage public.game_stage not null default 'LOBBY',
  current_question_index int not null default -1,
  question_count int not null,
  state_version bigint not null default 1,
  question_started_at timestamptz,
  question_deadline_at timestamptz,
  paused_remaining_ms int,
  stage_ends_at timestamptz,               -- end of the STARTING countdown
  time_override_sec int check (time_override_sec is null or time_override_sec between 5 and 300),
  auto_close_when_all_answered boolean not null default true,
  final_view text not null default 'podium' check (final_view in ('podium', 'ranking', 'recap')),
  -- Everything a participant / stage display is allowed to see for the current stage.
  -- Rebuilt by the server on every transition; never contains future questions
  -- and only contains correct answers once revealed.
  public_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index game_sessions_active_pin on public.game_sessions (game_pin) where status = 'active';
create index game_sessions_host_idx on public.game_sessions (host_id, created_at desc);

-- Immutable copy of the quiz at session creation: editing the quiz later never
-- changes historical results.
create table public.session_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  question_index int not null,
  kind public.question_kind not null,
  allow_multiple boolean not null default false,
  question_text text not null,
  image_url text,
  time_limit_sec int not null,
  explanation text,
  options jsonb not null,                  -- [{id, position, text, is_correct}]
  effective_time_limit_sec int,            -- set when opened (time override may apply)
  opened_at timestamptz,
  closed_at timestamptz,
  revealed boolean not null default false,
  results jsonb,                           -- cached distribution, computed at reveal
  constraint session_questions_unique unique (session_id, question_index)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  total_score int not null default 0,
  correct_answers_count int not null default 0,
  correct_time_ms bigint not null default 0,
  rank int,
  previous_rank int,
  eligible_from_index int not null default 0,
  removed boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint participants_one_per_user unique (session_id, auth_user_id)
);
create unique index participants_nickname_unique
  on public.participants (session_id, lower(nickname)) where not removed;
create index participants_session_idx on public.participants (session_id);

create table public.submitted_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  session_question_id uuid not null references public.session_questions (id) on delete cascade,
  question_index int not null,
  selected_option_ids uuid[] not null check (cardinality(selected_option_ids) between 1 and 8),
  submitted_at timestamptz not null default now(),
  response_time_ms int not null,
  is_correct boolean,                      -- null for polls
  points_awarded int not null default 0,
  constraint submitted_answers_once unique (participant_id, session_question_id)
);
create index submitted_answers_question_idx on public.submitted_answers (session_question_id);
create index submitted_answers_session_idx on public.submitted_answers (session_id);

-- Small, frequently-changing counters, kept off game_sessions so that answer
-- counts do not fan out to every participant's realtime subscription.
create table public.session_live (
  session_id uuid primary key references public.game_sessions (id) on delete cascade,
  question_index int not null default -1,
  answers_count int not null default 0,
  eligible_count int not null default 0,
  participants_count int not null default 0,
  connected_count int not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.host_profiles enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.answer_options enable row level security;
alter table public.game_sessions enable row level security;
alter table public.session_questions enable row level security;
alter table public.participants enable row level security;
alter table public.submitted_answers enable row level security;
alter table public.session_live enable row level security;

create or replace function public.is_host_user() returns boolean
language sql stable as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

create policy "own profile" on public.host_profiles for select to authenticated
  using (user_id = auth.uid());

create policy "hosts read own quizzes" on public.quizzes for select to authenticated
  using (owner_id = auth.uid() and public.is_host_user());
create policy "hosts delete own quizzes" on public.quizzes for delete to authenticated
  using (owner_id = auth.uid() and public.is_host_user());

create policy "hosts read own questions" on public.questions for select to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));

create policy "hosts read own options" on public.answer_options for select to authenticated
  using (exists (
    select 1 from public.questions qu join public.quizzes q on q.id = qu.quiz_id
    where qu.id = question_id and q.owner_id = auth.uid()));

-- Session rows hold only stage-appropriate public data (see public_state).
create policy "anyone signed in reads sessions" on public.game_sessions for select to authenticated
  using (true);
create policy "hosts delete own finished sessions" on public.game_sessions for delete to authenticated
  using (host_id = auth.uid() and status = 'finished');

create policy "hosts read session questions" on public.session_questions for select to authenticated
  using (exists (select 1 from public.game_sessions s where s.id = session_id and s.host_id = auth.uid()));

create policy "hosts and self read participants" on public.participants for select to authenticated
  using (auth_user_id = auth.uid()
      or exists (select 1 from public.game_sessions s where s.id = session_id and s.host_id = auth.uid()));

create policy "hosts read answers" on public.submitted_answers for select to authenticated
  using (exists (select 1 from public.game_sessions s where s.id = session_id and s.host_id = auth.uid()));

create policy "anyone signed in reads live counters" on public.session_live for select to authenticated
  using (true);

-- No insert/update/delete policies (other than the deletes above): every write
-- goes through the validated RPC functions.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant delete on public.quizzes, public.game_sessions to authenticated;
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.game_sessions, public.session_live, public.participants;

-- ---------------------------------------------------------------------------
-- Storage bucket for question images
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-images', 'quiz-images', true, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "hosts upload quiz images" on storage.objects for insert to authenticated
  with check (bucket_id = 'quiz-images' and public.is_host_user()
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hosts manage own quiz images" on storage.objects for delete to authenticated
  using (bucket_id = 'quiz-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "public read quiz images" on storage.objects for select
  using (bucket_id = 'quiz-images');

-- ===== supabase/migrations/20261122000200_game_engine.sql =====
-- Money Moves Live — authoritative game engine
--
-- Every function is SECURITY DEFINER with an explicit search_path and performs
-- its own authorization. Errors are raised with stable machine codes
-- (e.g. 'NICKNAME_TAKEN') that the client maps to friendly messages.
--
-- Locking discipline (prevents deadlocks): any function that changes a session
-- locks its game_sessions row FIRST (FOR UPDATE for transitions, FOR SHARE for
-- answer submissions), then touches other rows.

-- Grace period after a deadline during which an in-flight answer is accepted.
create or replace function public._grace_ms() returns int language sql immutable as $$ select 500 $$;
-- Duration of the "3, 2, 1" countdown when the quiz starts.
create or replace function public._starting_ms() returns int language sql immutable as $$ select 3000 $$;

-- ---------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------

-- Points for a correct answer: 500 + round(500 * remaining / duration), within [500, 1000].
create or replace function public.compute_points(p_remaining_ms int, p_duration_ms int)
returns int language sql immutable as $$
  select case
    when p_duration_ms is null or p_duration_ms <= 0 then 500
    else 500 + round(500.0 * least(greatest(coalesce(p_remaining_ms, 0), 0), p_duration_ms) / p_duration_ms)::int
  end
$$;

create or replace function public._assert_host() returns void language plpgsql stable as $$
begin
  if not public.is_host_user() then
    raise exception 'NOT_AUTHORIZED' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._new_pin() returns text language sql volatile as $$
  select lpad((floor(random() * 900000) + 100000)::int::text, 6, '0')
$$;

-- Public view of a question: never includes is_correct.
create or replace function public._public_question(q public.session_questions)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'index', q.question_index,
    'kind', q.kind,
    'allow_multiple', q.allow_multiple,
    'text', q.question_text,
    'image_url', q.image_url,
    'time_limit_ms', coalesce(q.effective_time_limit_sec, q.time_limit_sec) * 1000,
    'options', (
      select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'position', (o->>'position')::int, 'text', o->>'text')
                                order by (o->>'position')::int), '[]'::jsonb)
      from jsonb_array_elements(q.options) o)
  )
$$;

-- Distribution of answers for a question (computed from submitted answers).
create or replace function public._compute_results(p_question_id uuid)
returns jsonb language sql stable as $$
  with q as (select * from public.session_questions where id = p_question_id),
  counts as (
    select opt_id, count(*)::int as n
    from public.submitted_answers a, unnest(a.selected_option_ids) as opt_id
    where a.session_question_id = p_question_id
    group by opt_id
  )
  select jsonb_build_object(
    'total_answers', (select count(*)::int from public.submitted_answers where session_question_id = p_question_id),
    'correct_count', (select count(*)::int from public.submitted_answers where session_question_id = p_question_id and is_correct),
    'counts', (
      select coalesce(jsonb_object_agg(o->>'id', coalesce(c.n, 0)), '{}'::jsonb)
      from q, jsonb_array_elements(q.options) o
      left join counts c on c.opt_id = (o->>'id')::uuid),
    'correct_option_ids', (
      select coalesce(jsonb_agg(o->>'id'), '[]'::jsonb)
      from q, jsonb_array_elements(q.options) o
      where q.kind = 'quiz' and (o->>'is_correct')::boolean),
    'explanation', (select explanation from q)
  )
$$;

-- Recompute every participant's totals from submitted answers of REVEALED
-- questions only. Idempotent: running it twice never double counts.
-- p_shift_ranks moves the current rank to previous_rank (done once per new reveal).
create or replace function public._recompute_scores(p_session_id uuid, p_shift_ranks boolean)
returns void language plpgsql as $$
begin
  with agg as (
    select p.id,
           coalesce(sum(a.points_awarded) filter (where sq.revealed), 0)::int as score,
           (count(*) filter (where a.is_correct and sq.revealed))::int as cc,
           coalesce(sum(a.response_time_ms) filter (where a.is_correct and sq.revealed), 0)::bigint as ct
    from public.participants p
    left join public.submitted_answers a on a.participant_id = p.id
    left join public.session_questions sq on sq.id = a.session_question_id
    where p.session_id = p_session_id and not p.removed
    group by p.id
  ), ranked as (
    select agg.*, row_number() over (
      order by agg.score desc, agg.cc desc, agg.ct asc, p.joined_at asc, p.id asc) as rk
    from agg join public.participants p on p.id = agg.id
  )
  update public.participants p
     set previous_rank = case when p_shift_ranks then p.rank else p.previous_rank end,
         rank = r.rk,
         total_score = r.score,
         correct_answers_count = r.cc,
         correct_time_ms = r.ct
    from ranked r
   where p.id = r.id;
end $$;

create or replace function public._leaderboard(p_session_id uuid, p_limit int)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.rank), '[]'::jsonb)
  from (
    select id, nickname, total_score as score, rank, previous_rank, correct_answers_count as correct_count
    from public.participants
    where session_id = p_session_id and not removed and rank is not null
    order by rank
    limit p_limit
  ) t
$$;

-- Summary of every played question, for the final recap.
create or replace function public._recap(p_session_id uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'index', q.question_index,
      'kind', q.kind,
      'allow_multiple', q.allow_multiple,
      'text', q.question_text,
      'total_answers', coalesce((q.results->>'total_answers')::int, 0),
      'options', (
        select jsonb_agg(jsonb_build_object(
          'id', o->>'id', 'text', o->>'text', 'position', (o->>'position')::int,
          'count', coalesce((q.results->'counts'->>(o->>'id'))::int, 0),
          'is_correct', q.kind = 'quiz' and (o->>'is_correct')::boolean)
          order by (o->>'position')::int)
        from jsonb_array_elements(q.options) o)
    ) order by q.question_index), '[]'::jsonb)
  from public.session_questions q
  where q.session_id = p_session_id and q.opened_at is not null
$$;

-- Build the participant-safe state for a session row.
create or replace function public._public_state(s public.game_sessions)
returns jsonb language plpgsql stable as $$
declare
  q public.session_questions;
  st jsonb;
  has_quiz boolean;
begin
  select exists (select 1 from public.session_questions where session_id = s.id and kind = 'quiz') into has_quiz;
  st := jsonb_build_object(
    'quiz_title', s.quiz_title,
    'question_count', s.question_count,
    'show_leaderboard', s.show_leaderboard and has_quiz
  );

  if s.current_question_index >= 0 and s.current_stage in
     ('QUESTION_OPEN', 'QUESTION_PAUSED', 'QUESTION_CLOSED', 'ANSWER_REVEAL', 'LEADERBOARD') then
    select * into q from public.session_questions
     where session_id = s.id and question_index = s.current_question_index;
    st := st || jsonb_build_object('question', public._public_question(q));
    if s.current_stage = 'ANSWER_REVEAL' then
      st := st || jsonb_build_object('reveal', coalesce(q.results, public._compute_results(q.id)));
    end if;
    if s.current_stage in ('ANSWER_REVEAL', 'LEADERBOARD') and has_quiz then
      st := st || jsonb_build_object('leaderboard', public._leaderboard(s.id, 10));
    end if;
  end if;

  if s.current_stage = 'FINISHED' then
    st := st || jsonb_build_object(
      'leaderboard', case when has_quiz then public._leaderboard(s.id, null) else '[]'::jsonb end,
      'recap', public._recap(s.id),
      'final_view', s.final_view);
  end if;
  return st;
end $$;

-- Persist an in-memory session record: bumps the version and rebuilds public_state
-- in a single UPDATE so realtime subscribers see exactly one consistent event.
create or replace function public._commit(s public.game_sessions)
returns public.game_sessions language plpgsql as $$
declare
  out_row public.game_sessions;
begin
  s.state_version := s.state_version + 1;
  s.updated_at := now();
  s.public_state := public._public_state(s);
  update public.game_sessions g set
    status = s.status,
    current_stage = s.current_stage,
    current_question_index = s.current_question_index,
    state_version = s.state_version,
    question_started_at = s.question_started_at,
    question_deadline_at = s.question_deadline_at,
    paused_remaining_ms = s.paused_remaining_ms,
    stage_ends_at = s.stage_ends_at,
    time_override_sec = s.time_override_sec,
    auto_close_when_all_answered = s.auto_close_when_all_answered,
    final_view = s.final_view,
    game_pin = s.game_pin,
    public_state = s.public_state,
    started_at = s.started_at,
    finished_at = s.finished_at,
    updated_at = s.updated_at
  where g.id = s.id
  returning * into out_row;
  return out_row;
end $$;

-- Close the current question (no stage change on the record beyond timing fields).
create or replace function public._close_current(s public.game_sessions)
returns public.game_sessions language plpgsql as $$
begin
  if s.current_stage = 'QUESTION_OPEN' then
    s.paused_remaining_ms := null;
  end if;
  update public.session_questions set closed_at = coalesce(closed_at, clock_timestamp())
   where session_id = s.id and question_index = s.current_question_index;
  s.current_stage := 'QUESTION_CLOSED';
  return s;
end $$;

-- Compute and cache results; recompute scores. Returns true if this was the first reveal.
create or replace function public._reveal_current(s public.game_sessions)
returns boolean language plpgsql as $$
declare
  q public.session_questions;
begin
  select * into q from public.session_questions
   where session_id = s.id and question_index = s.current_question_index for update;
  if not found then return false; end if;
  update public.session_questions
     set results = public._compute_results(q.id), revealed = true, closed_at = coalesce(closed_at, clock_timestamp())
   where id = q.id;
  perform public._recompute_scores(s.id, not q.revealed);
  return not q.revealed;
end $$;

-- Open question p_index (or show its results if it was already played).
create or replace function public._open_question(s public.game_sessions, p_index int)
returns public.game_sessions language plpgsql as $$
declare
  q public.session_questions;
  eff int;
begin
  select * into q from public.session_questions
   where session_id = s.id and question_index = p_index for update;
  if not found then
    raise exception 'NO_MORE_QUESTIONS' using errcode = 'P0001';
  end if;

  s.current_question_index := p_index;
  s.stage_ends_at := null;

  if q.opened_at is not null then
    -- Already played (host navigated back): show its results again.
    if not q.revealed then
      perform public._reveal_current(s);
    end if;
    s.current_stage := 'ANSWER_REVEAL';
    s.paused_remaining_ms := null;
    update public.session_live set
      question_index = p_index,
      answers_count = (select count(*) from public.submitted_answers where session_question_id = q.id),
      updated_at = now()
    where session_id = s.id;
    return s;
  end if;

  eff := coalesce(s.time_override_sec, q.time_limit_sec);
  update public.session_questions set opened_at = now(), effective_time_limit_sec = eff where id = q.id;
  s.current_stage := 'QUESTION_OPEN';
  s.question_started_at := now();
  s.question_deadline_at := now() + make_interval(secs => eff);
  s.paused_remaining_ms := null;
  update public.session_live set
    question_index = p_index,
    answers_count = 0,
    eligible_count = (select count(*) from public.participants
                       where session_id = s.id and not removed and eligible_from_index <= p_index),
    updated_at = now()
  where session_id = s.id;
  return s;
end $$;

-- ---------------------------------------------------------------------------
-- Quiz management
-- ---------------------------------------------------------------------------

-- Atomically create or replace a quiz and all its questions from a JSON document:
-- {title, description, show_leaderboard, questions: [{kind, allow_multiple,
--  question_text, image_url, time_limit_sec, explanation, options: [{text, is_correct}]}]}
create or replace function public.save_quiz(p_quiz_id uuid, p_quiz jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := p_quiz_id;
  v_title text := btrim(coalesce(p_quiz->>'title', ''));
  qd jsonb;
  od jsonb;
  qi int := 0;
  oi int;
  v_kind public.question_kind;
  v_multi boolean;
  v_text text;
  v_limit int;
  v_qid uuid;
  n_opts int;
  n_correct int;
begin
  perform public._assert_host();
  if v_title = '' then raise exception 'INVALID_QUIZ: title is required' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_quiz->'questions', '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_QUIZ: questions must be an array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(coalesce(p_quiz->'questions', '[]'::jsonb)) > 100 then
    raise exception 'INVALID_QUIZ: at most 100 questions' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.quizzes (owner_id, title, description, show_leaderboard, is_sample)
    values (auth.uid(), left(v_title, 120), left(coalesce(p_quiz->>'description', ''), 500),
            coalesce((p_quiz->>'show_leaderboard')::boolean, true),
            coalesce((p_quiz->>'is_sample')::boolean, false))
    returning id into v_id;
  else
    update public.quizzes set
      title = left(v_title, 120),
      description = left(coalesce(p_quiz->>'description', ''), 500),
      show_leaderboard = coalesce((p_quiz->>'show_leaderboard')::boolean, true),
      updated_at = now()
    where id = v_id and owner_id = auth.uid();
    if not found then raise exception 'QUIZ_NOT_FOUND' using errcode = 'P0001'; end if;
    delete from public.questions where quiz_id = v_id;
  end if;

  for qd in select * from jsonb_array_elements(coalesce(p_quiz->'questions', '[]'::jsonb)) loop
    qi := qi + 1;
    v_kind := coalesce(nullif(qd->>'kind', ''), 'quiz')::public.question_kind;
    v_multi := v_kind = 'poll' and coalesce((qd->>'allow_multiple')::boolean, false);
    v_text := btrim(coalesce(qd->>'question_text', ''));
    v_limit := coalesce((qd->>'time_limit_sec')::int, 20);
    if v_text = '' then
      raise exception 'INVALID_QUIZ: question % has no text', qi using errcode = 'P0001';
    end if;
    if char_length(v_text) > 300 then
      raise exception 'INVALID_QUIZ: question % is longer than 300 characters', qi using errcode = 'P0001';
    end if;
    if v_limit < 5 or v_limit > 300 then
      raise exception 'INVALID_QUIZ: question % time limit must be between 5 and 300 seconds', qi using errcode = 'P0001';
    end if;
    n_opts := jsonb_array_length(coalesce(qd->'options', '[]'::jsonb));
    if n_opts < 2 or n_opts > 8 then
      raise exception 'INVALID_QUIZ: question % needs between 2 and 8 answers', qi using errcode = 'P0001';
    end if;
    select count(*) into n_correct from jsonb_array_elements(qd->'options') o
     where coalesce((o->>'is_correct')::boolean, false);
    if v_kind = 'quiz' and n_correct <> 1 then
      raise exception 'INVALID_QUIZ: question % must have exactly one correct answer', qi using errcode = 'P0001';
    end if;

    insert into public.questions (quiz_id, order_index, kind, allow_multiple, question_text, image_url, time_limit_sec, explanation)
    values (v_id, qi - 1, v_kind, v_multi, v_text,
            nullif(btrim(coalesce(qd->>'image_url', '')), ''), v_limit,
            nullif(btrim(left(coalesce(qd->>'explanation', ''), 600)), ''))
    returning id into v_qid;

    oi := 0;
    for od in select * from jsonb_array_elements(qd->'options') loop
      if btrim(coalesce(od->>'text', '')) = '' then
        raise exception 'INVALID_QUIZ: question % answer % is empty', qi, oi + 1 using errcode = 'P0001';
      end if;
      if char_length(btrim(od->>'text')) > 120 then
        raise exception 'INVALID_QUIZ: question % answer % is longer than 120 characters', qi, oi + 1 using errcode = 'P0001';
      end if;
      insert into public.answer_options (question_id, position, answer_text, is_correct)
      values (v_qid, oi, btrim(od->>'text'), v_kind = 'quiz' and coalesce((od->>'is_correct')::boolean, false));
      oi := oi + 1;
    end loop;
  end loop;
  return v_id;
end $$;

-- Export a quiz as the same JSON document save_quiz accepts.
create or replace function public.get_quiz_document(p_quiz_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  doc jsonb;
begin
  perform public._assert_host();
  select jsonb_build_object(
    'title', q.title,
    'description', q.description,
    'show_leaderboard', q.show_leaderboard,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', qu.kind,
        'allow_multiple', qu.allow_multiple,
        'question_text', qu.question_text,
        'image_url', qu.image_url,
        'time_limit_sec', qu.time_limit_sec,
        'explanation', qu.explanation,
        'options', (select jsonb_agg(jsonb_build_object('text', o.answer_text, 'is_correct', o.is_correct) order by o.position)
                    from public.answer_options o where o.question_id = qu.id)
      ) order by qu.order_index)
      from public.questions qu where qu.quiz_id = q.id), '[]'::jsonb)
  ) into doc
  from public.quizzes q where q.id = p_quiz_id and q.owner_id = auth.uid();
  if doc is null then raise exception 'QUIZ_NOT_FOUND' using errcode = 'P0001'; end if;
  return doc;
end $$;

create or replace function public.duplicate_quiz(p_quiz_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  doc jsonb;
begin
  doc := public.get_quiz_document(p_quiz_id);
  doc := jsonb_set(doc, '{title}', to_jsonb(left((doc->>'title') || ' (copie)', 120)));
  return public.save_quiz(null, doc);
end $$;

-- ---------------------------------------------------------------------------
-- Session lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.create_session(p_quiz_id uuid)
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare
  qz public.quizzes;
  s public.game_sessions;
  n int;
  attempt int := 0;
begin
  perform public._assert_host();
  select * into qz from public.quizzes where id = p_quiz_id and owner_id = auth.uid();
  if not found then raise exception 'QUIZ_NOT_FOUND' using errcode = 'P0001'; end if;
  select count(*) into n from public.questions where quiz_id = qz.id;
  if n = 0 then raise exception 'QUIZ_EMPTY' using errcode = 'P0001'; end if;

  loop
    attempt := attempt + 1;
    begin
      insert into public.game_sessions (quiz_id, host_id, game_pin, quiz_title, show_leaderboard, question_count)
      values (qz.id, auth.uid(), public._new_pin(), qz.title, qz.show_leaderboard, n)
      returning * into s;
      exit;
    exception when unique_violation then
      if attempt > 20 then raise; end if;
    end;
  end loop;

  insert into public.session_questions
    (session_id, question_index, kind, allow_multiple, question_text, image_url, time_limit_sec, explanation, options)
  select s.id, qu.order_index, qu.kind, qu.allow_multiple, qu.question_text, qu.image_url, qu.time_limit_sec, qu.explanation,
         (select jsonb_agg(jsonb_build_object('id', o.id, 'position', o.position, 'text', o.answer_text, 'is_correct', o.is_correct)
                           order by o.position)
            from public.answer_options o where o.question_id = qu.id)
  from public.questions qu where qu.quiz_id = qz.id;

  -- Normalise question indexes to 0..n-1 regardless of gaps.
  with ordered as (
    select id, row_number() over (order by question_index) - 1 as idx
    from public.session_questions where session_id = s.id)
  update public.session_questions sq set question_index = -1 - o.idx from ordered o where sq.id = o.id;
  update public.session_questions set question_index = -1 - question_index where session_id = s.id;

  insert into public.session_live (session_id) values (s.id);
  return public._commit(s);
end $$;

create or replace function public.lookup_session(p_pin text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'game_pin', game_pin, 'quiz_title', quiz_title, 'stage', current_stage)
  from public.game_sessions
  where game_pin = btrim(p_pin) and status = 'active'
  limit 1
$$;

create or replace function public.join_session(p_pin text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  p public.participants;
  v_nick text := regexp_replace(btrim(coalesce(p_nickname, '')), '\s+', ' ', 'g');
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001'; end if;
  select * into s from public.game_sessions where game_pin = btrim(p_pin) and status = 'active' for share;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;

  -- Rejoin: the same browser identity always maps to the same participant.
  select * into p from public.participants where session_id = s.id and auth_user_id = auth.uid();
  if found then
    if p.removed then raise exception 'PARTICIPANT_REMOVED' using errcode = 'P0001'; end if;
    update public.participants set last_seen_at = now() where id = p.id;
    return jsonb_build_object('session_id', s.id, 'participant_id', p.id, 'nickname', p.nickname, 'rejoined', true);
  end if;

  if char_length(v_nick) < 1 or char_length(v_nick) > 24 then
    raise exception 'INVALID_NICKNAME' using errcode = 'P0001';
  end if;
  if (select count(*) from public.participants where session_id = s.id) >= 1000 then
    raise exception 'SESSION_FULL' using errcode = 'P0001';
  end if;

  begin
    insert into public.participants (session_id, auth_user_id, nickname, eligible_from_index)
    -- Late joiners spectate the question in progress and play from the next one.
    values (s.id, auth.uid(), v_nick, greatest(s.current_question_index + 1, 0))
    returning * into p;
  exception when unique_violation then
    raise exception 'NICKNAME_TAKEN' using errcode = 'P0001';
  end;

  update public.session_live set participants_count = participants_count + 1,
                                 connected_count = connected_count + 1, updated_at = now()
   where session_id = s.id;
  return jsonb_build_object('session_id', s.id, 'participant_id', p.id, 'nickname', p.nickname, 'rejoined', false);
end $$;

-- Everything a participant needs about themself. Correctness and points of the
-- current answer are only returned once the question has been revealed.
create or replace function public.player_state(p_session_id uuid)
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
  select * into p from public.participants where session_id = s.id and auth_user_id = auth.uid();
  if not found then
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

create or replace function public.submit_answer(p_session_id uuid, p_question_index int, p_option_ids uuid[])
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
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001'; end if;
  -- Shared lock: concurrent answers proceed in parallel, but a stage transition
  -- (FOR UPDATE) waits for in-flight answers and vice versa.
  select * into s from public.game_sessions where id = p_session_id for share;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  -- Timestamp taken after acquiring the lock, so it is always earlier than any
  -- subsequent closed_at and later than any preceding question open.
  v_now := clock_timestamp();

  select * into p from public.participants where session_id = s.id and auth_user_id = auth.uid();
  if not found or p.removed then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0001'; end if;

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

  -- Note: is_correct / points are deliberately NOT returned before the reveal.
  return jsonb_build_object('accepted', true, 'duplicate', inserted_id is null, 'submitted_at', v_now,
                            'selected_option_ids', to_jsonb(v_ids));
end $$;

-- Time-driven transitions. Safe for anyone in the session to call: it only
-- performs a transition when the authoritative clock says it is due.
create or replace function public.tick_session(p_session_id uuid)
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  live public.session_live;
  due boolean;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001'; end if;
  select * into s from public.game_sessions where id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into live from public.session_live where session_id = s.id;

  due := (s.current_stage = 'STARTING' and s.stage_ends_at <= now())
      or (s.current_stage = 'QUESTION_OPEN' and (
            now() >= s.question_deadline_at + make_interval(secs => public._grace_ms() / 1000.0)
         or (s.auto_close_when_all_answered and live.eligible_count > 0 and live.answers_count >= live.eligible_count)));
  if not due then return s; end if;

  -- Re-check under the lock: another caller may have performed the transition.
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

-- Every presenter command. p_expected_version protects against double clicks
-- and conflicting presenter tabs: a command based on a stale view is rejected.
create or replace function public.host_action(
  p_session_id uuid, p_action text, p_expected_version bigint default null, p_args jsonb default '{}'::jsonb)
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare
  s public.game_sessions;
  v_remaining int;
  v_secs int;
  q public.session_questions;
  n_answers int;
begin
  perform public._assert_host();
  select * into s from public.game_sessions where id = p_session_id for update;
  if not found or s.host_id <> auth.uid() then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_expected_version is not null and p_expected_version <> s.state_version then
    raise exception 'STALE_STATE' using errcode = 'P0001';
  end if;

  case p_action
  when 'start' then
    if s.current_stage <> 'LOBBY' then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    s.current_stage := 'STARTING';
    s.stage_ends_at := now() + make_interval(secs => public._starting_ms() / 1000.0);
    s.started_at := now();

  when 'pause' then
    if s.current_stage <> 'QUESTION_OPEN' then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    v_remaining := greatest(0, (extract(epoch from (s.question_deadline_at - now())) * 1000)::int);
    if v_remaining = 0 then
      s := public._close_current(s);
    else
      s.current_stage := 'QUESTION_PAUSED';
      s.paused_remaining_ms := v_remaining;
      s.question_deadline_at := null;
    end if;

  when 'resume' then
    if s.current_stage <> 'QUESTION_PAUSED' then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    s.current_stage := 'QUESTION_OPEN';
    s.question_deadline_at := now() + make_interval(secs => coalesce(s.paused_remaining_ms, 0) / 1000.0);
    s.paused_remaining_ms := null;

  when 'close' then
    if s.current_stage not in ('QUESTION_OPEN', 'QUESTION_PAUSED') then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    s := public._close_current(s);

  when 'reveal' then
    if s.current_stage not in ('QUESTION_OPEN', 'QUESTION_PAUSED', 'QUESTION_CLOSED') then
      raise exception 'INVALID_TRANSITION' using errcode = 'P0001';
    end if;
    if s.current_stage <> 'QUESTION_CLOSED' then s := public._close_current(s); end if;
    perform public._reveal_current(s);
    s.current_stage := 'ANSWER_REVEAL';

  when 'leaderboard' then
    if s.current_stage <> 'ANSWER_REVEAL' then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    s.current_stage := 'LEADERBOARD';

  when 'next' then
    if s.current_stage not in ('ANSWER_REVEAL', 'LEADERBOARD') then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    if s.current_question_index + 1 >= s.question_count then raise exception 'NO_MORE_QUESTIONS' using errcode = 'P0001'; end if;
    s := public._open_question(s, s.current_question_index + 1);

  when 'previous' then
    if s.current_stage not in ('QUESTION_OPEN', 'QUESTION_PAUSED', 'QUESTION_CLOSED', 'ANSWER_REVEAL', 'LEADERBOARD')
       or s.current_question_index <= 0 then
      raise exception 'INVALID_TRANSITION' using errcode = 'P0001';
    end if;
    if s.current_stage in ('QUESTION_OPEN', 'QUESTION_PAUSED', 'QUESTION_CLOSED') then
      select * into q from public.session_questions where session_id = s.id and question_index = s.current_question_index;
      select count(*) into n_answers from public.submitted_answers where session_question_id = q.id;
      if n_answers = 0 then
        -- Nothing was answered: the question becomes unplayed again.
        update public.session_questions set opened_at = null, closed_at = null, effective_time_limit_sec = null where id = q.id;
      else
        s := public._close_current(s);
        perform public._reveal_current(s);
      end if;
    end if;
    s := public._open_question(s, s.current_question_index - 1);

  when 'finish' then
    if s.current_stage = 'FINISHED' then raise exception 'INVALID_TRANSITION' using errcode = 'P0001'; end if;
    if s.current_stage in ('QUESTION_OPEN', 'QUESTION_PAUSED', 'QUESTION_CLOSED') then
      s := public._close_current(s);
      perform public._reveal_current(s);
    end if;
    -- Make sure every played question has cached results and scores are final.
    update public.session_questions set results = public._compute_results(id), revealed = true
     where session_id = s.id and opened_at is not null and not revealed;
    perform public._recompute_scores(s.id, false);
    s.current_stage := 'FINISHED';
    s.status := 'finished';
    s.finished_at := now();
    s.question_deadline_at := null;
    s.paused_remaining_ms := null;
    s.final_view := case
      when s.show_leaderboard and exists (select 1 from public.session_questions where session_id = s.id and kind = 'quiz')
      then 'podium' else 'recap' end;

  when 'final_view' then
    if s.current_stage <> 'FINISHED' or coalesce(p_args->>'view', '') not in ('podium', 'ranking', 'recap') then
      raise exception 'INVALID_TRANSITION' using errcode = 'P0001';
    end if;
    s.final_view := p_args->>'view';

  when 'set_timer' then
    v_secs := nullif(p_args->>'seconds', '')::int;
    if v_secs is not null and (v_secs < 5 or v_secs > 300) then raise exception 'INVALID_ARGUMENT' using errcode = 'P0001'; end if;
    s.time_override_sec := v_secs;

  when 'set_auto_close' then
    s.auto_close_when_all_answered := coalesce((p_args->>'enabled')::boolean, true);

  when 'remove_participant' then
    update public.participants set removed = true
     where id = (p_args->>'participant_id')::uuid and session_id = s.id and not removed;
    if found then
      update public.session_live set
        participants_count = greatest(participants_count - 1, 0),
        eligible_count = case when s.current_stage in ('QUESTION_OPEN', 'QUESTION_PAUSED')
          then (select count(*) from public.participants where session_id = s.id and not removed
                  and eligible_from_index <= s.current_question_index)
          else eligible_count end
      where session_id = s.id;
      if s.current_stage not in ('LOBBY', 'STARTING') then
        perform public._recompute_scores(s.id, false);
      end if;
    end if;

  when 'reset' then
    if s.status = 'finished' then
      -- The PIN may have been reused since; pick a fresh one if needed.
      if exists (select 1 from public.game_sessions where game_pin = s.game_pin and status = 'active') then
        loop
          s.game_pin := public._new_pin();
          exit when not exists (select 1 from public.game_sessions where game_pin = s.game_pin and status = 'active');
        end loop;
      end if;
    end if;
    delete from public.submitted_answers where session_id = s.id;
    update public.session_questions set opened_at = null, closed_at = null, revealed = false, results = null,
                                        effective_time_limit_sec = null where session_id = s.id;
    update public.participants set total_score = 0, correct_answers_count = 0, correct_time_ms = 0,
                                   rank = null, previous_rank = null, eligible_from_index = 0 where session_id = s.id;
    update public.session_live set question_index = -1, answers_count = 0, eligible_count = 0, updated_at = now()
     where session_id = s.id;
    s.current_stage := 'LOBBY';
    s.status := 'active';
    s.current_question_index := -1;
    s.question_started_at := null;
    s.question_deadline_at := null;
    s.paused_remaining_ms := null;
    s.stage_ends_at := null;
    s.started_at := null;
    s.finished_at := null;
    s.final_view := 'podium';

  else
    raise exception 'UNKNOWN_ACTION' using errcode = 'P0001';
  end case;

  return public._commit(s);
end $$;

-- Liveness: participants ping every ~15 s. Returns the server time (used for clock sync).
create or replace function public.heartbeat(p_session_id uuid)
returns timestamptz language plpgsql security definer set search_path = public as $$
begin
  update public.participants set last_seen_at = now()
   where session_id = p_session_id and auth_user_id = auth.uid() and last_seen_at < now() - interval '5 seconds';
  return clock_timestamp();
end $$;

create or replace function public.server_time()
returns timestamptz language sql volatile as $$ select clock_timestamp() $$;

-- Recount connected participants (seen in the last 35 s). Called periodically by host/stage.
create or replace function public.refresh_presence(p_session_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001'; end if;
  select count(*) into n from public.participants
   where session_id = p_session_id and not removed and last_seen_at > now() - interval '35 seconds';
  update public.session_live set connected_count = n, updated_at = now()
   where session_id = p_session_id and connected_count is distinct from n;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.is_host_user(), public.compute_points(int, int),
  public.save_quiz(uuid, jsonb), public.get_quiz_document(uuid), public.duplicate_quiz(uuid),
  public.create_session(uuid), public.lookup_session(text), public.join_session(text, text),
  public.player_state(uuid), public.submit_answer(uuid, int, uuid[]), public.tick_session(uuid),
  public.host_action(uuid, text, bigint, jsonb), public.heartbeat(uuid), public.server_time(),
  public.refresh_presence(uuid)
to authenticated;
-- Internal helpers stay private (callable only from the definer functions above).
revoke execute on function
  public._grace_ms(), public._starting_ms(), public._assert_host(), public._new_pin(),
  public._public_question(public.session_questions), public._compute_results(uuid),
  public._recompute_scores(uuid, boolean), public._leaderboard(uuid, int), public._recap(uuid),
  public._public_state(public.game_sessions), public._commit(public.game_sessions),
  public._close_current(public.game_sessions), public._reveal_current(public.game_sessions),
  public._open_question(public.game_sessions, int)
from authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ===== supabase/migrations/20261122000300_samples.sql =====
-- Demonstration content. Seeded once per host account (flagged is_sample, shown
-- with an "Exemple" badge) and never mixed with imported or user-created quizzes.

create or replace function public._sample_documents() returns jsonb language sql immutable as $json$
select $$[
{
  "title": "Money Talks — le sondage",
  "description": "11 questions anonymes pour lancer la discussion : épargne, investissement, ambitions.",
  "show_leaderboard": false,
  "is_sample": true,
  "questions": [
    {"kind":"poll","question_text":"As-tu déjà investi ?","time_limit_sec":30,
     "options":[{"text":"Oui, régulièrement"},{"text":"Oui, une fois ou deux"},{"text":"Pas encore mais je veux"},{"text":"Non"}]},
    {"kind":"poll","question_text":"Combien tu mets de côté ou investis par mois ?","time_limit_sec":30,
     "options":[{"text":"0 €"},{"text":"< 50 €"},{"text":"50–150 €"},{"text":"150–300 €"},{"text":"300 €+"},{"text":"Je préfère ne pas dire"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Tu as ouvert quoi ?","time_limit_sec":30,
     "options":[{"text":"Livret A"},{"text":"PEA"},{"text":"Compte-titres"},{"text":"Assurance-vie"},{"text":"PER"},{"text":"Crypto"},{"text":"Rien encore"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Ce que tu as en portefeuille","time_limit_sec":30,
     "options":[{"text":"ETF World"},{"text":"ETF S&P 500"},{"text":"ETF Nasdaq 100"},{"text":"Actions en direct (Nvidia, LVMH…)"},{"text":"Crypto"},{"text":"Immobilier ou SCPI"},{"text":"Rien"}]},
    {"kind":"poll","question_text":"Ton objectif n°1 en investissant","time_limit_sec":30,
     "options":[{"text":"Faire grossir mon patrimoine"},{"text":"Ma retraite"},{"text":"Un achat (appart…)"},{"text":"Mon indépendance financière"},{"text":"Apprendre"},{"text":"Je ne sais pas encore"}]},
    {"kind":"poll","question_text":"Ton horizon","time_limit_sec":30,
     "options":[{"text":"< 2 ans"},{"text":"2–5 ans"},{"text":"5–10 ans"},{"text":"10 ans+"}]},
    {"kind":"poll","question_text":"Ton profil","time_limit_sec":30,
     "options":[{"text":"🐢 Prudente"},{"text":"🦊 Équilibrée"},{"text":"🚀 Je prends des risques"},{"text":"🙈 Aucune idée"}]},
    {"kind":"poll","question_text":"Qui t’a parlé d’investissement en premier ?","time_limit_sec":30,
     "options":[{"text":"Mes parents"},{"text":"Une amie"},{"text":"Les réseaux sociaux"},{"text":"L’école"},{"text":"Personne"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Tu t’éduques comment financièrement ?","time_limit_sec":30,
     "options":[{"text":"YouTube"},{"text":"TikTok"},{"text":"Instagram"},{"text":"Newsletters"},{"text":"Podcasts"},{"text":"Livres"},{"text":"Mon entourage"},{"text":"Pas encore"}]},
    {"kind":"poll","question_text":"As-tu déjà négocié ton salaire ?","time_limit_sec":30,
     "options":[{"text":"Oui et j’ai obtenu plus"},{"text":"Oui mais refusé"},{"text":"Non, je n’ai pas osé"},{"text":"Pas encore eu l’occasion"}]},
    {"kind":"poll","question_text":"Tu as un side business à côté ?","time_limit_sec":30,
     "options":[{"text":"Oui, en cours"},{"text":"Oui, une idée"},{"text":"Non"}]}
  ]
},
{
  "title": "Quiz finance express",
  "description": "8 questions notées pour tester ses bases. Rapidité récompensée !",
  "show_leaderboard": true,
  "is_sample": true,
  "questions": [
    {"kind":"quiz","question_text":"Que signifie « ETF » ?","time_limit_sec":20,
     "explanation":"Un ETF (Exchange Traded Fund) est un fonds coté en Bourse qui réplique un indice, comme le MSCI World.",
     "options":[{"text":"Exchange Traded Fund","is_correct":true},{"text":"European Tax Fund"},{"text":"Equity Transfer Fee"},{"text":"Electronic Trading Fund"}]},
    {"kind":"quiz","question_text":"Quel est le plafond de versement du Livret A ?","time_limit_sec":20,
     "explanation":"22 950 € hors intérêts capitalisés : les intérêts peuvent faire dépasser ce plafond.",
     "options":[{"text":"10 000 €"},{"text":"15 300 €"},{"text":"22 950 €","is_correct":true},{"text":"50 000 €"}]},
    {"kind":"quiz","question_text":"À 7 % par an, en combien de temps ton capital double-t-il environ ?","time_limit_sec":20,
     "explanation":"Règle de 72 : 72 ÷ 7 ≈ 10 ans. C'est la magie des intérêts composés.",
     "options":[{"text":"~5 ans"},{"text":"~10 ans","is_correct":true},{"text":"~20 ans"},{"text":"~30 ans"}]},
    {"kind":"quiz","question_text":"Le PEA permet d’investir principalement dans…","time_limit_sec":20,
     "explanation":"Le PEA est réservé aux actions européennes (et aux ETF éligibles, y compris certains ETF World).",
     "options":[{"text":"Des cryptomonnaies"},{"text":"Des actions européennes","is_correct":true},{"text":"De l’immobilier physique"},{"text":"Des matières premières"}]},
    {"kind":"quiz","question_text":"Après combien d’années le PEA devient-il fiscalement avantageux ?","time_limit_sec":20,
     "explanation":"Après 5 ans, les gains ne sont plus soumis à l'impôt sur le revenu (seuls les prélèvements sociaux restent dus).",
     "options":[{"text":"2 ans"},{"text":"5 ans","is_correct":true},{"text":"8 ans"},{"text":"10 ans"}]},
    {"kind":"quiz","question_text":"Diversifier son portefeuille sert surtout à…","time_limit_sec":15,
     "explanation":"Répartir ses placements limite l'impact d'une mauvaise surprise sur un seul actif.",
     "options":[{"text":"Garantir un gain"},{"text":"Réduire le risque","is_correct":true},{"text":"Éviter les impôts"},{"text":"Payer moins de frais"}]},
    {"kind":"quiz","question_text":"Les intérêts composés, c’est…","time_limit_sec":15,
     "explanation":"Tes intérêts produisent à leur tour des intérêts : l'effet boule de neige.",
     "options":[{"text":"Un taux fixe garanti"},{"text":"Gagner des intérêts sur ses intérêts","is_correct":true},{"text":"Un type de prêt bancaire"},{"text":"Une taxe sur l’épargne"}]},
    {"kind":"quiz","question_text":"Vrai ou faux : un rendement élevé sans aucun risque, ça existe.","time_limit_sec":10,
     "explanation":"Faux ! Rendement et risque vont toujours de pair. Méfie-toi des promesses trop belles.",
     "options":[{"text":"Vrai"},{"text":"Faux","is_correct":true}]}
  ]
}
]$$::jsonb
$json$;

create or replace function public.ensure_sample_quizzes()
returns int language plpgsql security definer set search_path = public as $$
declare
  doc jsonb;
  n int := 0;
begin
  perform public._assert_host();
  insert into public.host_profiles (user_id) values (auth.uid()) on conflict do nothing;
  if (select samples_seeded_at from public.host_profiles where user_id = auth.uid()) is not null then
    return 0;
  end if;
  for doc in select * from jsonb_array_elements(public._sample_documents()) loop
    perform public.save_quiz(null, doc);
    n := n + 1;
  end loop;
  update public.host_profiles set samples_seeded_at = now() where user_id = auth.uid();
  return n;
end $$;

revoke execute on function public._sample_documents() from public, anon, authenticated;
revoke execute on function public.ensure_sample_quizzes() from public, anon;
grant execute on function public.ensure_sample_quizzes() to authenticated;

-- ===== supabase/migrations/20261122000400_security_hardening.sql =====
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

-- ===== supabase/migrations/20261122000500_player_tokens.sql =====
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

