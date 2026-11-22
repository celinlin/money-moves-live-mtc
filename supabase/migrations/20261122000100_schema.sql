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
