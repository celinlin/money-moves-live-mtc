#!/usr/bin/env node
// Load test: N real players (separate anonymous Supabase identities, each with its
// own realtime WebSocket) play a full game driven by a real host account.
// Verifies realtime delivery, submission success, no duplicates and score integrity.
//
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... [DATABASE_URL=...] node scripts/load-test.mjs --players 100 --questions 4
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => s.trim().split(/\s+/)));
const N = Number(args.players ?? 100);
const QUESTIONS = Number(args.questions ?? 4);
const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const KEY = process.env.SUPABASE_ANON_KEY;
const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!KEY) {
  console.error('Set SUPABASE_ANON_KEY');
  process.exit(1);
}

const mk = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 50 } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => performance.now();
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]?.toFixed(0);
  return `n=${s.length} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${s.at(-1)?.toFixed(0)}ms`;
};

async function rpc(client, fn, params) {
  const { data, error } = await client.rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// --- Host ------------------------------------------------------------------
const host = mk();
const email = `load-${Date.now()}@test.local`;
{
  const { data, error } = await host.auth.signUp({ email, password: 'load-test-password' });
  if (error) throw error;
  // Presenters are allow-listed server-side (owner action).
  const admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  await admin.query('insert into public.app_hosts (user_id) values ($1) on conflict do nothing', [data.user.id]);
  await admin.end();
}
const quizDoc = {
  title: `Load test ${new Date().toISOString()}`,
  show_leaderboard: true,
  questions: Array.from({ length: QUESTIONS }, (_, i) => ({
    kind: i % 2 === 0 ? 'quiz' : 'poll',
    allow_multiple: i % 4 === 3,
    question_text: `Question ${i + 1}`,
    time_limit_sec: 20,
    options: [0, 1, 2, 3].map((k) => ({ text: `Option ${k + 1}`, is_correct: i % 2 === 0 && k === 0 })),
  })),
};
const quizId = await rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc });
let session = await rpc(host, 'create_session', { p_quiz_id: quizId });
console.log(`Session ${session.game_pin} — ${N} players, ${QUESTIONS} questions`);

// --- Players: sign in + join concurrently -----------------------------------
const players = Array.from({ length: N }, (_, i) => ({ i, client: mk(), version: 0, received: new Map(), submitted: new Set(), errors: [] }));
const joinTimes = [];
await Promise.all(
  players.map(async (p) => {
    const t0 = t();
    // Phones need no account: join_session issues a device token.
    const res = await rpc(p.client, 'join_session', { p_pin: session.game_pin, p_nickname: `Player ${p.i}` });
    p.participantId = res.participant_id;
    p.token = res.token;
    joinTimes.push(t() - t0);
  }),
);
console.log(`✔ ${N} players joined           ${stats(joinTimes)}`);

// Realtime subscriptions.
const actionAt = new Map(); // version → host action timestamp
const latencies = [];
const submitTimes = [];
await Promise.all(
  players.map(
    (p) =>
      new Promise((resolve, reject) => {
        const ch = p.client.channel(`load:${p.i}`);
        ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${session.id}` }, (payload) => {
          const row = payload.new;
          if (row.state_version <= p.version) return;
          p.version = row.state_version;
          p.received.set(row.state_version, row.current_stage);
          const sentAt = actionAt.get(row.state_version);
          if (sentAt) latencies.push(t() - sentAt);
          if (row.current_stage === 'QUESTION_OPEN') void answer(p, row);
        });
        ch.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`player ${p.i} realtime ${status}`));
        });
        p.channel = ch;
      }),
  ),
);
console.log(`✔ ${N} realtime subscriptions active`);

async function answer(p, row) {
  const q = row.public_state.question;
  if (p.submitted.has(q.index)) return;
  p.submitted.add(q.index);
  await sleep(200 + Math.random() * 2500); // humans take time to tap
  const ids = q.allow_multiple ? [q.options[p.i % 4].id, q.options[(p.i + 1) % 4].id] : [q.options[p.i % 4].id];
  const t0 = t();
  try {
    await rpc(p.client, 'submit_answer', { p_session_id: session.id, p_question_index: q.index, p_option_ids: ids, p_token: p.token });
    // Simulate a flaky network: 10% of players retry the same submission.
    if (p.i % 10 === 0) await rpc(p.client, 'submit_answer', { p_session_id: session.id, p_question_index: q.index, p_option_ids: ids, p_token: p.token });
    submitTimes.push(t() - t0);
  } catch (e) {
    p.errors.push(e.message);
  }
}

async function hostAction(action) {
  const t0 = t();
  const { data, error } = await host.rpc('host_action', { p_session_id: session.id, p_action: action, p_expected_version: session.state_version, p_args: {} });
  if (error) throw new Error(`${action}: ${error.message}`);
  actionAt.set(data.state_version, t0);
  session = data;
  return data;
}

async function waitFor(cond, timeout = 30000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await sleep(100);
  }
}

// --- Play -------------------------------------------------------------------
await hostAction('start');
await sleep(3100);
session = await rpc(host, 'tick_session', { p_session_id: session.id });
actionAt.set(session.state_version, t());

for (let qi = 0; qi < QUESTIONS; qi++) {
  if (qi > 0) await hostAction('next');
  // Wait for all answers (auto-close when everyone answered).
  await waitFor(async () => {
    const { data } = await host.from('session_live').select('answers_count, eligible_count').eq('session_id', session.id).single();
    return data.answers_count >= data.eligible_count;
  });
  session = await rpc(host, 'tick_session', { p_session_id: session.id });
  actionAt.set(session.state_version, t());
  await hostAction('reveal');
  if (session.public_state.question.kind === 'quiz') await hostAction('leaderboard');
  console.log(`✔ question ${qi + 1}: ${session.public_state.reveal?.total_answers ?? '-'} answers, stage ${session.current_stage}`);
}
await hostAction('finish');
await sleep(1500);

// --- Verify -----------------------------------------------------------------
const finalVersion = session.state_version;
const missed = players.filter((p) => p.version < finalVersion).length;
const errors = players.flatMap((p) => p.errors);
const db = new pg.Client({ connectionString: DB });
await db.connect();
const { rows: [dups] } = await db.query(
  `select count(*)::int as n from (select participant_id, session_question_id from submitted_answers where session_id = $1 group by 1, 2 having count(*) > 1) x`,
  [session.id],
);
const { rows: [counts] } = await db.query(`select count(*)::int as answers from submitted_answers where session_id = $1`, [session.id]);
const { rows: [mismatch] } = await db.query(
  `select count(*)::int as n from participants p where p.session_id = $1 and p.total_score <>
     (select coalesce(sum(points_awarded),0) from submitted_answers a where a.participant_id = p.id)`,
  [session.id],
);
const { rows: [ranks] } = await db.query(`select count(distinct rank)::int as d, count(*)::int as n from participants where session_id = $1`, [session.id]);
await db.end();

console.log('\n── Results ─────────────────────────────────────────');
console.log(`Realtime delivery latency (host action → player): ${stats(latencies)}`);
console.log(`Answer submission round-trip:                     ${stats(submitTimes)}`);
console.log(`Players that missed the final state:              ${missed}`);
console.log(`Submission errors:                                 ${errors.length}${errors.length ? ' — ' + [...new Set(errors)].join('; ') : ''}`);
console.log(`Stored answers: ${counts.answers} (expected ${N * QUESTIONS}) · duplicates: ${dups.n} · score mismatches: ${mismatch.n} · unique ranks: ${ranks.d}/${ranks.n}`);

const ok = missed === 0 && errors.length === 0 && dups.n === 0 && mismatch.n === 0 && counts.answers === N * QUESTIONS && ranks.d === ranks.n;
console.log(ok ? '\nPASS' : '\nFAIL');
await Promise.all(players.map((p) => p.client.removeAllChannels()));
process.exit(ok ? 0 : 1);
