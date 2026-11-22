// Test helpers that talk to the real (local Supabase) Postgres and impersonate
// Supabase users exactly as PostgREST does: role `authenticated` + JWT claims.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  max: 30,
});

export interface TestUser {
  id: string;
  anon: boolean;
  /** Players: device token issued by join_session (they use the public anon role). */
  token?: string;
}

/** createUser(true) = a phone (public anon role, identified by its join token). */
export async function createUser(anon: boolean): Promise<TestUser> {
  const id = randomUUID();
  if (anon) return { id, anon: true };
  await pool.query(
    `insert into auth.users (id, aud, role, email, is_anonymous, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, $3, now(), now())`,
    [id, anon ? null : `host-${id}@test.local`, anon],
  );
  // Presenters must be on the allow-list (see the security hardening migration).
  if (!anon) await pool.query('insert into public.app_hosts (user_id) values ($1) on conflict do nothing', [id]);
  return { id, anon };
}

/** A signed-in, non-anonymous account that is NOT an allowed presenter. */
export async function createUnlistedUser(): Promise<TestUser> {
  const id = randomUUID();
  await pool.query(
    `insert into auth.users (id, aud, role, email, is_anonymous, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, false, now(), now())`,
    [id, `stranger-${id}@test.local`],
  );
  return { id, anon: false };
}

/** Run one statement as `user` in its own transaction (like one PostgREST request). */
export async function as<T = Record<string, unknown>>(user: TestUser, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (user.anon) {
      await client.query('set local role anon');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
    } else {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user.id, role: 'authenticated', is_anonymous: false }),
      ]);
    }
    const res = await client.query(sql, params);
    await client.query('commit');
    return res.rows as T[];
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const TOKEN_FNS = new Set(['player_state', 'submit_answer', 'heartbeat', 'join_session']);

export async function rpc<T = any>(user: TestUser, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (TOKEN_FNS.has(fn) && user.token && !('p_token' in args)) args = { ...args, p_token: user.token };
  if (fn !== 'join_session' && TOKEN_FNS.has(fn) && !('p_token' in args)) args = { ...args, p_token: null };
  const keys = Object.keys(args);
  const sql = `select to_jsonb(r) as v from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`;
  const rows = await as<{ v: any }>(user, sql, keys.map((k) => args[k]));
  const v = rows[0]?.v;
  // Scalar-returning functions come back wrapped as {fn: value}.
  const out = v && typeof v === 'object' && !Array.isArray(v) && fn in v && Object.keys(v).length === 1 ? v[fn] : v;
  if (fn === 'join_session' && out?.token) user.token = out.token;
  return out;
}

export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    if (String(e.message).includes(code)) return;
    throw new Error(`Expected error ${code}, got: ${e.message}`);
  }
  throw new Error(`Expected error ${code}, but call succeeded`);
}

export const quizDoc = (overrides: Partial<Record<string, unknown>> = {}) => ({
  title: 'Test quiz',
  description: 'integration',
  show_leaderboard: true,
  questions: [
    {
      kind: 'quiz',
      question_text: 'Q1?',
      time_limit_sec: 20,
      options: [{ text: 'A', is_correct: true }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
    },
    {
      kind: 'quiz',
      question_text: 'Q2?',
      time_limit_sec: 10,
      options: [{ text: 'Yes' }, { text: 'No', is_correct: true }],
    },
    {
      kind: 'poll',
      allow_multiple: true,
      question_text: 'Poll?',
      time_limit_sec: 30,
      options: [{ text: 'X' }, { text: 'Y' }, { text: 'Z' }],
    },
  ],
  ...overrides,
});

/** Move a session's deadlines into the past (simulates time passing). */
export async function expireDeadline(sessionId: string) {
  await pool.query(
    `update public.game_sessions set question_deadline_at = now() - interval '2 seconds',
            stage_ends_at = case when stage_ends_at is null then null else now() - interval '1 second' end
     where id = $1`,
    [sessionId],
  );
}

export async function forceStartingDone(sessionId: string) {
  await pool.query(`update public.game_sessions set stage_ends_at = now() - interval '1 second' where id = $1`, [sessionId]);
}
