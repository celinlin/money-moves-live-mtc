import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createUser, expectError, expireDeadline, forceStartingDone, pool, quizDoc, rpc, type TestUser } from './db';

let host: TestUser;
let otherHost: TestUser;
let quizId: string;

beforeAll(async () => {
  host = await createUser(false);
  otherHost = await createUser(false);
  quizId = await rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() });
});

afterAll(async () => {
  await pool.end();
});

async function newSession() {
  const s = await rpc(host, 'create_session', { p_quiz_id: quizId });
  return s as { id: string; game_pin: string; state_version: number; public_state: any };
}

async function joinPlayers(pin: string, n: number, prefix = 'P') {
  const players: { user: TestUser; participantId: string; nickname: string }[] = [];
  for (let i = 0; i < n; i++) {
    const user = await createUser(true);
    const res = await rpc(user, 'join_session', { p_pin: pin, p_nickname: `${prefix}${i}` });
    players.push({ user, participantId: res.participant_id, nickname: res.nickname });
  }
  return players;
}

async function session(id: string) {
  const { rows } = await pool.query('select * from public.game_sessions where id = $1', [id]);
  return rows[0];
}

async function act(sessionId: string, action: string, args: Record<string, unknown> = {}) {
  const s = await session(sessionId);
  return rpc(host, 'host_action', {
    p_session_id: sessionId,
    p_action: action,
    p_expected_version: s.state_version,
    p_args: args,
  });
}

/** Start the quiz and open question 0. */
async function startAndOpen(sessionId: string, tickUser: TestUser) {
  await act(sessionId, 'start');
  await forceStartingDone(sessionId);
  return rpc(tickUser, 'tick_session', { p_session_id: sessionId });
}

describe('quiz management', () => {
  it('validates quiz documents server-side', async () => {
    const bad = quizDoc({
      questions: [{ kind: 'quiz', question_text: 'No correct', time_limit_sec: 20, options: [{ text: 'a' }, { text: 'b' }] }],
    });
    await expectError(rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: bad }), 'exactly one correct answer');
    const tooFew = quizDoc({
      questions: [{ kind: 'quiz', question_text: 'x', time_limit_sec: 20, options: [{ text: 'a', is_correct: true }] }],
    });
    await expectError(rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: tooFew }), 'between 2 and 8');
    const badTime = quizDoc({
      questions: [{ kind: 'poll', question_text: 'x', time_limit_sec: 2, options: [{ text: 'a' }, { text: 'b' }] }],
    });
    await expectError(rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: badTime }), 'time limit');
  });

  it('refuses anonymous users and other hosts', async () => {
    const anon = await createUser(true);
    await expectError(rpc(anon, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() }), 'permission denied');
    await expectError(rpc(otherHost, 'save_quiz', { p_quiz_id: quizId, p_quiz: quizDoc() }), 'QUIZ_NOT_FOUND');
    const visible = await as(otherHost, 'select id from public.quizzes where id = $1', [quizId]);
    expect(visible).toHaveLength(0);
  });

  it('round-trips, duplicates and seeds samples once', async () => {
    const doc = await rpc(host, 'get_quiz_document', { p_quiz_id: quizId });
    expect(doc.questions).toHaveLength(3);
    expect(doc.questions[2].allow_multiple).toBe(true);
    const copyId = await rpc(host, 'duplicate_quiz', { p_quiz_id: quizId });
    const copy = await rpc(host, 'get_quiz_document', { p_quiz_id: copyId });
    expect(copy.title).toBe('Test quiz (copie)');
    expect(copy.questions).toEqual(doc.questions);

    const fresh = await createUser(false);
    expect(await rpc(fresh, 'ensure_sample_quizzes')).toBe(2);
    expect(await rpc(fresh, 'ensure_sample_quizzes')).toBe(0);
    const rows = await as(fresh, 'select title, is_sample from public.quizzes');
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.is_sample)).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('creates a session with a 6-digit PIN and a private question snapshot', async () => {
    const s = await newSession();
    expect(s.game_pin).toMatch(/^\d{6}$/);
    expect(s.public_state.question_count).toBe(3);
    expect(JSON.stringify(s.public_state)).not.toContain('is_correct');

    const player = await createUser(true);
    // Participants cannot read the answer key.
    await expectError(as(player, 'select * from public.session_questions where session_id = $1', [s.id]), 'permission denied');
    const hostSnap = await as(host, 'select * from public.session_questions where session_id = $1', [s.id]);
    expect(hostSnap).toHaveLength(3);

    // Editing the quiz afterwards does not change the session snapshot.
    const q2 = await createUser(false);
    void q2;
    const doc = await rpc(host, 'get_quiz_document', { p_quiz_id: quizId });
    doc.questions[0].question_text = 'EDITED';
    await rpc(host, 'save_quiz', { p_quiz_id: quizId, p_quiz: doc });
    const after = await as<any>(host, 'select question_text from public.session_questions where session_id = $1 and question_index = 0', [s.id]);
    expect(after[0].question_text).toBe('Q1?');
    doc.questions[0].question_text = 'Q1?';
    await rpc(host, 'save_quiz', { p_quiz_id: quizId, p_quiz: doc });
  });

  it('registers players, rejects duplicate nicknames, and rejoins idempotently', async () => {
    const s = await newSession();
    const alice = await createUser(true);
    const first = await rpc(alice, 'join_session', { p_pin: s.game_pin, p_nickname: '  Alice  ' });
    expect(first.nickname).toBe('Alice');
    const again = await rpc(alice, 'join_session', { p_pin: s.game_pin, p_nickname: 'Other name' });
    expect(again.participant_id).toBe(first.participant_id);
    expect(again.rejoined).toBe(true);

    const bob = await createUser(true);
    await expectError(rpc(bob, 'join_session', { p_pin: s.game_pin, p_nickname: 'alice' }), 'NICKNAME_TAKEN');
    await expectError(rpc(bob, 'join_session', { p_pin: '000000', p_nickname: 'Bob' }), 'SESSION_NOT_FOUND');
    await expectError(rpc(bob, 'join_session', { p_pin: s.game_pin, p_nickname: '   ' }), 'INVALID_NICKNAME');

    const { rows } = await pool.query('select participants_count from public.session_live where session_id = $1', [s.id]);
    expect(rows[0].participants_count).toBe(1);
  });

  it('runs a full game: answers, timer expiry, reveal, scores, leaderboard, finish', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 3);
    const opened = await startAndOpen(s.id, players[0].user);
    expect(opened.current_stage).toBe('QUESTION_OPEN');
    const q0 = opened.public_state.question;
    expect(q0.index).toBe(0);
    expect(JSON.stringify(opened.public_state)).not.toContain('is_correct');
    expect(opened.public_state.reveal).toBeUndefined();

    const doc = await rpc(host, 'get_quiz_document', { p_quiz_id: quizId });
    const correctPos = doc.questions[0].options.findIndex((o: any) => o.is_correct);
    const correctId = q0.options[correctPos].id;
    const wrongId = q0.options[(correctPos + 1) % 4].id;

    // P0 correct, P1 wrong, P2 does not answer.
    const r0 = await rpc(players[0].user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [correctId] });
    expect(r0.accepted).toBe(true);
    expect(r0.is_correct).toBeUndefined(); // never revealed early
    await rpc(players[1].user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [wrongId] });

    // Duplicate submission is idempotent and does not change the answer.
    const dup = await rpc(players[0].user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [wrongId] });
    expect(dup.duplicate).toBe(true);
    expect(dup.selected_option_ids).toEqual([correctId]);

    // Player state hides correctness and does not leak points before reveal.
    const ps = await rpc(players[0].user, 'player_state', { p_session_id: s.id });
    expect(ps.answer.is_correct).toBeNull();
    expect(ps.answer.points).toBeNull();
    expect(ps.participant.total_score).toBe(0);

    // Timer expires: late answers are rejected, tick closes the question.
    await expireDeadline(s.id);
    await expectError(
      rpc(players[2].user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [correctId] }),
      'QUESTION_CLOSED',
    );
    const closed = await rpc(players[2].user, 'tick_session', { p_session_id: s.id });
    expect(closed.current_stage).toBe('QUESTION_CLOSED');

    const revealed = await act(s.id, 'reveal');
    expect(revealed.current_stage).toBe('ANSWER_REVEAL');
    expect(revealed.public_state.reveal.correct_option_ids).toEqual([correctId]);
    expect(revealed.public_state.reveal.total_answers).toBe(2);
    expect(revealed.public_state.reveal.counts[correctId]).toBe(1);

    const ps0 = await rpc(players[0].user, 'player_state', { p_session_id: s.id });
    expect(ps0.answer.is_correct).toBe(true);
    expect(ps0.answer.points).toBeGreaterThanOrEqual(500);
    expect(ps0.answer.points).toBeLessThanOrEqual(1000);
    expect(ps0.participant.total_score).toBe(ps0.answer.points);
    expect(ps0.participant.rank).toBe(1);
    const ps1 = await rpc(players[1].user, 'player_state', { p_session_id: s.id });
    expect(ps1.answer.is_correct).toBe(false);
    expect(ps1.answer.points).toBe(0);

    const lb = await act(s.id, 'leaderboard');
    expect(lb.current_stage).toBe('LEADERBOARD');
    expect(lb.public_state.leaderboard[0].nickname).toBe('P0');

    const next = await act(s.id, 'next');
    expect(next.current_stage).toBe('QUESTION_OPEN');
    expect(next.current_question_index).toBe(1);
    const { rows: live } = await pool.query('select * from public.session_live where session_id = $1', [s.id]);
    expect(live[0].answers_count).toBe(0);
    expect(live[0].eligible_count).toBe(3);

    // Revealing again never duplicates scores.
    const before = (await rpc(players[0].user, 'player_state', { p_session_id: s.id })).participant.total_score;
    await act(s.id, 'reveal');
    await act(s.id, 'previous'); // back to Q1 results
    await act(s.id, 'next'); // Q2 already played → shows results again
    const afterNav = await session(s.id);
    expect(afterNav.current_stage).toBe('ANSWER_REVEAL');
    expect(afterNav.current_question_index).toBe(1);
    const after = (await rpc(players[0].user, 'player_state', { p_session_id: s.id })).participant.total_score;
    expect(after).toBe(before);

    await act(s.id, 'next'); // poll, multiple choice
    const poll = (await session(s.id)).public_state.question;
    expect(poll.allow_multiple).toBe(true);
    const ids = poll.options.map((o: any) => o.id);
    await rpc(players[0].user, 'submit_answer', { p_session_id: s.id, p_question_index: 2, p_option_ids: [ids[0], ids[1]] });
    await rpc(players[1].user, 'submit_answer', { p_session_id: s.id, p_question_index: 2, p_option_ids: [ids[1]] });
    await expectError(
      rpc(players[2].user, 'submit_answer', { p_session_id: s.id, p_question_index: 2, p_option_ids: ['00000000-0000-0000-0000-000000000000'] }),
      'INVALID_ANSWER',
    );
    const pollReveal = await act(s.id, 'reveal');
    expect(pollReveal.public_state.reveal.counts[ids[1]]).toBe(2);
    expect(pollReveal.public_state.reveal.total_answers).toBe(2);
    expect(pollReveal.public_state.reveal.correct_option_ids).toEqual([]);

    await expectError(act(s.id, 'next'), 'NO_MORE_QUESTIONS');
    const fin = await act(s.id, 'finish');
    expect(fin.current_stage).toBe('FINISHED');
    expect(fin.status).toBe('finished');
    expect(fin.final_view).toBe('podium');
    expect(fin.public_state.leaderboard).toHaveLength(3);
    expect(fin.public_state.recap).toHaveLength(3);
    expect(fin.public_state.recap[0].options.some((o: any) => o.is_correct)).toBe(true);

    // Finished sessions no longer accept players.
    const late = await createUser(true);
    await expectError(rpc(late, 'join_session', { p_pin: s.game_pin, p_nickname: 'Late' }), 'SESSION_NOT_FOUND');
  });

  it('pauses and resumes with the remaining time preserved', async () => {
    const s = await newSession();
    const [p] = await joinPlayers(s.game_pin, 1);
    await startAndOpen(s.id, p.user);
    const paused = await act(s.id, 'pause');
    expect(paused.current_stage).toBe('QUESTION_PAUSED');
    expect(paused.question_deadline_at).toBeNull();
    expect(paused.paused_remaining_ms).toBeGreaterThan(18000);
    const optId = paused.public_state.question.options[0].id;
    await expectError(
      rpc(p.user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [optId] }),
      'QUESTION_PAUSED',
    );
    const resumed = await act(s.id, 'resume');
    expect(resumed.current_stage).toBe('QUESTION_OPEN');
    const remaining = new Date(resumed.question_deadline_at).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(17000);
    expect(remaining).toBeLessThanOrEqual(20500);
  });

  it('auto-closes once every eligible player has answered', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 2);
    const opened = await startAndOpen(s.id, players[0].user);
    const opt = opened.public_state.question.options[0].id;
    for (const p of players) {
      await rpc(p.user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [opt] });
    }
    const ticked = await rpc(players[0].user, 'tick_session', { p_session_id: s.id });
    expect(ticked.current_stage).toBe('QUESTION_CLOSED');
  });

  it('lets late joiners spectate the open question and play from the next one', async () => {
    const s = await newSession();
    const [p] = await joinPlayers(s.game_pin, 1);
    const opened = await startAndOpen(s.id, p.user);
    const late = await createUser(true);
    await rpc(late, 'join_session', { p_pin: s.game_pin, p_nickname: 'Late' });
    const opt = opened.public_state.question.options[0].id;
    await expectError(rpc(late, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [opt] }), 'NOT_ELIGIBLE');
    await act(s.id, 'reveal');
    const next = await act(s.id, 'next');
    const opt2 = next.public_state.question.options[0].id;
    const r = await rpc(late, 'submit_answer', { p_session_id: s.id, p_question_index: 1, p_option_ids: [opt2] });
    expect(r.accepted).toBe(true);
    const { rows } = await pool.query('select eligible_count from public.session_live where session_id = $1', [s.id]);
    expect(rows[0].eligible_count).toBe(2);
  });

  it('rejects stale and invalid host commands, and non-host callers', async () => {
    const s = await newSession();
    const [p] = await joinPlayers(s.game_pin, 1);
    const fresh = await session(s.id);
    await rpc(host, 'host_action', { p_session_id: s.id, p_action: 'start', p_expected_version: fresh.state_version, p_args: {} });
    // Same version again (double click / second tab) → rejected.
    await expectError(
      rpc(host, 'host_action', { p_session_id: s.id, p_action: 'start', p_expected_version: fresh.state_version, p_args: {} }),
      'STALE_STATE',
    );
    await expectError(act(s.id, 'leaderboard'), 'INVALID_TRANSITION');
    await expectError(
      rpc(p.user, 'host_action', { p_session_id: s.id, p_action: 'finish', p_expected_version: null, p_args: {} }),
      'permission denied',
    );
    await expectError(
      rpc(otherHost, 'host_action', { p_session_id: s.id, p_action: 'finish', p_expected_version: null, p_args: {} }),
      'SESSION_NOT_FOUND',
    );
  });

  it('enforces row level security for participants', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 2);
    const opened = await startAndOpen(s.id, players[0].user);
    await rpc(players[0].user, 'submit_answer', {
      p_session_id: s.id, p_question_index: 0, p_option_ids: [opened.public_state.question.options[0].id],
    });
    // Phones use the public role: no direct access to answers or participants at all.
    await expectError(as(players[0].user, 'select * from public.submitted_answers where session_id = $1', [s.id]), 'permission denied');
    await expectError(as(players[0].user, 'select id from public.participants where session_id = $1', [s.id]), 'permission denied');
    // A forged / missing token is rejected.
    await expectError(
      rpc(players[1].user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [opened.public_state.question.options[0].id], p_token: 'x'.repeat(64) }),
      'NOT_A_PARTICIPANT',
    );
    const forged = await rpc(players[1].user, 'player_state', { p_session_id: s.id, p_token: 'y'.repeat(64) });
    expect(forged.joined).toBe(false);
    await expectError(
      as(players[0].user, 'update public.participants set total_score = 99999 where session_id = $1', [s.id]),
      'permission denied',
    );
    await expectError(
      as(players[0].user, 'update public.game_sessions set current_stage = $2 where id = $1', [s.id, 'FINISHED']),
      'permission denied',
    );
    await expectError(as(players[0].user, 'select public._recompute_scores($1, true)', [s.id]), 'permission denied');
    const hostView = await as(host, 'select * from public.submitted_answers where session_id = $1', [s.id]);
    expect(hostView).toHaveLength(1);
  });

  it('resets a session back to the lobby without losing participants', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 2);
    const opened = await startAndOpen(s.id, players[0].user);
    await rpc(players[0].user, 'submit_answer', {
      p_session_id: s.id, p_question_index: 0, p_option_ids: [opened.public_state.question.options[0].id],
    });
    await act(s.id, 'reveal');
    const reset = await act(s.id, 'reset');
    expect(reset.current_stage).toBe('LOBBY');
    expect(reset.current_question_index).toBe(-1);
    const { rows } = await pool.query('select count(*)::int n from public.submitted_answers where session_id = $1', [s.id]);
    expect(rows[0].n).toBe(0);
    const ps = await rpc(players[0].user, 'player_state', { p_session_id: s.id });
    expect(ps.joined).toBe(true);
    expect(ps.participant.total_score).toBe(0);
  });
});

describe('concurrency', () => {
  it('accepts 100 simultaneous answers exactly once each', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 100, 'C');
    const opened = await startAndOpen(s.id, players[0].user);
    const opts = opened.public_state.question.options.map((o: any) => o.id);

    // Every player submits twice, all at once.
    const calls = players.flatMap((p, i) => [0, 1].map(() =>
      rpc(p.user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [opts[i % 4]] })));
    const results = await Promise.all(calls);
    expect(results.every((r: any) => r.accepted)).toBe(true);

    const { rows } = await pool.query(
      'select count(*)::int n, count(distinct participant_id)::int d from public.submitted_answers where session_id = $1', [s.id]);
    expect(rows[0]).toEqual({ n: 100, d: 100 });
    const { rows: live } = await pool.query('select answers_count from public.session_live where session_id = $1', [s.id]);
    expect(live[0].answers_count).toBe(100);

    const revealed = await act(s.id, 'reveal');
    const counts = revealed.public_state.reveal.counts;
    expect(Object.values(counts).reduce((a: number, b: any) => a + b, 0)).toBe(100);
    const { rows: scores } = await pool.query(
      'select count(*) filter (where total_score >= 500)::int winners, count(distinct rank)::int ranks from public.participants where session_id = $1', [s.id]);
    expect(scores[0].winners).toBe(25);
    expect(scores[0].ranks).toBe(100); // deterministic, unique ranks
  });

  it('applies concurrent identical host commands only once', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 1);
    await startAndOpen(s.id, players[0].user);
    await act(s.id, 'reveal');
    const v = (await session(s.id)).state_version;
    const attempts = await Promise.allSettled([1, 2, 3, 4, 5].map(() =>
      rpc(host, 'host_action', { p_session_id: s.id, p_action: 'next', p_expected_version: v, p_args: {} })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const final = await session(s.id);
    expect(final.current_question_index).toBe(1);
    expect(Number(final.state_version)).toBe(Number(v) + 1);
  });

  it('serialises answers against question closing (no answer accepted after close)', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 40, 'R');
    const opened = await startAndOpen(s.id, players[0].user);
    const opt = opened.public_state.question.options[0].id;
    const v = (await session(s.id)).state_version;
    const submits = players.map((p) =>
      rpc(p.user, 'submit_answer', { p_session_id: s.id, p_question_index: 0, p_option_ids: [opt] })
        .then(() => 'ok').catch((e) => (String(e.message).includes('QUESTION_CLOSED') ? 'closed' : String(e.message))));
    const close = rpc(host, 'host_action', { p_session_id: s.id, p_action: 'close', p_expected_version: v, p_args: {} });
    const [res] = await Promise.all([Promise.all(submits), close]);
    expect(res.every((r) => r === 'ok' || r === 'closed')).toBe(true);
    const accepted = res.filter((r) => r === 'ok').length;
    const revealed = await act(s.id, 'reveal');
    expect(revealed.public_state.reveal.total_answers).toBe(accepted);
    const { rows } = await pool.query(
      `select count(*)::int n from public.submitted_answers a join public.session_questions q on q.id = a.session_question_id
       where a.session_id = $1 and a.submitted_at > q.closed_at`, [s.id]);
    expect(rows[0].n).toBe(0);
  });
});

describe('scoring and ranking', () => {
  it('computes points within [500, 1000]', async () => {
    const anyUser = host;
    const cases: [number, number, number][] = [
      [20000, 20000, 1000], [10000, 20000, 750], [0, 20000, 500], [-50, 20000, 500], [25000, 20000, 1000],
    ];
    for (const [rem, dur, expected] of cases) {
      expect(await rpc(anyUser, 'compute_points', { p_remaining_ms: rem, p_duration_ms: dur })).toBe(expected);
    }
  });

  it('breaks ties by correct count, then total correct response time', async () => {
    const s = await newSession();
    const players = await joinPlayers(s.game_pin, 3, 'T');
    await startAndOpen(s.id, players[0].user);
    const { rows: [sq] } = await pool.query(
      'select id from public.session_questions where session_id = $1 and question_index = 0', [s.id]);
    // Craft identical scores with different response times directly (as the service role).
    const mk = (pid: string, ms: number, pts: number, correct: boolean) => pool.query(
      `insert into public.submitted_answers (session_id, participant_id, session_question_id, question_index, selected_option_ids, response_time_ms, is_correct, points_awarded)
       values ($1, $2, $3, 0, array[gen_random_uuid()], $4, $5, $6)`, [s.id, pid, sq.id, ms, correct, pts]);
    await mk(players[0].participantId, 4000, 800, true);
    await mk(players[1].participantId, 3000, 800, true);
    await mk(players[2].participantId, 1000, 0, false);
    const rev = await act(s.id, 'reveal');
    const lb = rev.public_state.leaderboard;
    expect(lb.map((r: any) => r.nickname)).toEqual(['T1', 'T0', 'T2']);
  });
});
