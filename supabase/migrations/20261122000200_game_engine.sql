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
