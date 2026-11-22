import { afterAll, describe, expect, it } from 'vitest';
import { as, createUnlistedUser, createUser, expectError, pool, quizDoc, rpc } from './db';

afterAll(async () => {
  await pool.end();
});

describe('presenter allow-list', () => {
  it('signed-in accounts that are not allow-listed cannot act as presenters', async () => {
    const stranger = await createUnlistedUser();
    await expectError(rpc(stranger, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() }), 'NOT_AUTHORIZED');
    await expectError(rpc(stranger, 'ensure_sample_quizzes'), 'NOT_AUTHORIZED');
    const status = await rpc(stranger, 'host_status');
    expect(status.is_host).toBe(false);
    // The platform is already claimed (hosts exist), so a stranger cannot claim it.
    expect(status.can_claim).toBe(false);
    expect(await rpc(stranger, 'claim_first_host')).toBe(false);
    expect((await rpc(stranger, 'host_status')).is_host).toBe(false);
  });

  it('phones (public role) can never claim or host', async () => {
    const anon = await createUser(true);
    await expectError(rpc(anon, 'claim_first_host'), 'permission denied');
    await expectError(rpc(anon, 'host_status'), 'permission denied');
    await expectError(rpc(anon, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() }), 'permission denied');
    await expectError(rpc(anon, 'host_action', { p_session_id: '00000000-0000-0000-0000-000000000000', p_action: 'finish', p_expected_version: null, p_args: {} }), 'permission denied');
  });

  it('the allow-list itself is not readable or writable by users', async () => {
    const host = await createUser(false);
    await expectError(as(host, 'select * from public.app_hosts'), 'permission denied');
    await expectError(as(host, 'insert into public.app_hosts (user_id) values ($1)', [host.id]), 'permission denied');
  });

  it('allowed presenters keep working', async () => {
    const host = await createUser(false);
    expect((await rpc(host, 'host_status')).is_host).toBe(true);
    const id = await rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() });
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('session visibility', () => {
  it('old finished sessions are only visible to their host and participants', async () => {
    const host = await createUser(false);
    const quizId = await rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() });
    const s = await rpc(host, 'create_session', { p_quiz_id: quizId });
    const player = await createUser(true);
    await rpc(player, 'join_session', { p_pin: s.game_pin, p_nickname: 'Visible' });
    const stranger = await createUser(true);

    // Active: visible to everyone signed in (needed to join / project by code).
    expect(await as(stranger, 'select id from public.game_sessions where id = $1', [s.id])).toHaveLength(1);

    await rpc(host, 'host_action', { p_session_id: s.id, p_action: 'finish', p_expected_version: null, p_args: {} });
    // Recently finished: still visible so a stage screen can show the podium.
    expect(await as(stranger, 'select id from public.game_sessions where id = $1', [s.id])).toHaveLength(1);

    // Simulate the grace window elapsing.
    await pool.query(`update public.game_sessions set finished_at = now() - interval '13 hours' where id = $1`, [s.id]);
    expect(await as(stranger, 'select id from public.game_sessions where id = $1', [s.id])).toHaveLength(0);
    expect(await as(stranger, 'select session_id from public.session_live where session_id = $1', [s.id])).toHaveLength(0);
    // Phones only see sessions during the game + 12 h; the host keeps full history.
    expect(await as(player, 'select id from public.game_sessions where id = $1', [s.id])).toHaveLength(0);
    expect(await as(host, 'select id from public.game_sessions where id = $1', [s.id])).toHaveLength(1);
  });
});

describe('privileges', () => {
  it('users cannot truncate tables or call internal functions', async () => {
    const anon = await createUser(true);
    await expectError(as(anon, 'truncate public.submitted_answers'), 'permission denied');
    await expectError(as(anon, 'truncate public.participants'), 'permission denied');
    await expectError(as(anon, 'select public._sample_documents()'), 'permission denied');
    await expectError(as(anon, 'select public._commit(null::public.game_sessions)'), 'permission denied');
  });

  it('every public function has a pinned search_path and every table has RLS', async () => {
    const { rows: fns } = await pool.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(fns).toEqual([]);
    const { rows: tables } = await pool.query(`
      select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(tables).toEqual([]);
  });

  it('the public role only reaches player functions and public session data', async () => {
    const anon = await createUser(true);
    expect(typeof (await rpc(anon, 'host_signup_open'))).toBe('boolean');
    for (const table of ['quizzes', 'questions', 'answer_options', 'session_questions', 'participants', 'submitted_answers', 'host_profiles', 'app_hosts']) {
      await expectError(as(anon, `select * from public.${table} limit 1`), 'permission denied');
    }
    await expectError(as(anon, `update public.game_sessions set current_stage = 'FINISHED'`), 'permission denied');
    await expectError(rpc(anon, 'create_session', { p_quiz_id: '00000000-0000-0000-0000-000000000000' }), 'permission denied');
    await expectError(rpc(anon, 'get_quiz_document', { p_quiz_id: '00000000-0000-0000-0000-000000000000' }), 'permission denied');
  });

  it('tokens are stored hashed and only grant access to their own session', async () => {
    const host = await createUser(false);
    const quizId = await rpc(host, 'save_quiz', { p_quiz_id: null, p_quiz: quizDoc() });
    const a = await rpc(host, 'create_session', { p_quiz_id: quizId });
    const b = await rpc(host, 'create_session', { p_quiz_id: quizId });
    const phone = await createUser(true);
    const res = await rpc(phone, 'join_session', { p_pin: a.game_pin, p_nickname: 'Token' });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    const { rows } = await pool.query('select token_hash from public.participants where id = $1', [res.participant_id]);
    expect(rows[0].token_hash).not.toBe(res.token);
    // The token of session A is worthless in session B.
    expect((await rpc(phone, 'player_state', { p_session_id: b.id })).joined).toBe(false);
    // Rejoining with the token returns the same participant without creating a new one.
    const again = await rpc(phone, 'join_session', { p_pin: a.game_pin, p_nickname: 'Other' });
    expect(again.participant_id).toBe(res.participant_id);
    expect(again.rejoined).toBe(true);
  });
});
