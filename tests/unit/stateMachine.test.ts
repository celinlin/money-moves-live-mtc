import { describe, expect, it } from 'vitest';
import { canPerform, getPrimaryAction, isTickDue, TRANSITIONS } from '@/lib/stateMachine';
import type { GameSession, GameStage, PublicState } from '@/lib/types';

function session(stage: GameStage, idx = 0, count = 3, ps: PublicState = {}, extra: Partial<GameSession> = {}): GameSession {
  return {
    id: 's', quiz_id: 'q', host_id: 'h', game_pin: '123456', quiz_title: 'T', show_leaderboard: true, status: 'active',
    current_stage: stage, current_question_index: idx, question_count: count, state_version: 1,
    question_started_at: null, question_deadline_at: null, paused_remaining_ms: null, stage_ends_at: null,
    time_override_sec: null, auto_close_when_all_answered: true, final_view: 'podium', public_state: ps,
    created_at: '', started_at: null, finished_at: null, updated_at: '', ...extra,
  };
}
const quizQ = { show_leaderboard: true, question: { kind: 'quiz' } } as PublicState;
const pollQ = { show_leaderboard: true, question: { kind: 'poll' } } as PublicState;

describe('primary action', () => {
  it('follows the presenter flow for scored questions', () => {
    expect(getPrimaryAction(session('LOBBY', -1)).action).toBe('start');
    expect(getPrimaryAction(session('STARTING', -1)).disabled).toBe(true);
    expect(getPrimaryAction(session('QUESTION_OPEN', 0, 3, quizQ)).action).toBe('reveal');
    expect(getPrimaryAction(session('QUESTION_CLOSED', 0, 3, quizQ)).label).toBe('Révéler les résultats');
    expect(getPrimaryAction(session('ANSWER_REVEAL', 0, 3, quizQ)).action).toBe('leaderboard');
    expect(getPrimaryAction(session('LEADERBOARD', 0, 3, quizQ)).action).toBe('next');
    expect(getPrimaryAction(session('LEADERBOARD', 2, 3, quizQ))).toMatchObject({ action: 'finish', label: 'Résultats finaux' });
  });
  it('skips the leaderboard for polls and anonymous quizzes', () => {
    expect(getPrimaryAction(session('ANSWER_REVEAL', 0, 3, pollQ))).toMatchObject({ action: 'next', label: 'Question suivante' });
    const anon = { show_leaderboard: false, question: { kind: 'poll' } } as PublicState;
    expect(getPrimaryAction(session('ANSWER_REVEAL', 2, 3, anon))).toMatchObject({ action: 'finish', label: 'Voir le récap' });
  });
  it('cycles final views', () => {
    expect(getPrimaryAction(session('FINISHED', 2, 3, { show_leaderboard: true }))).toMatchObject({ action: 'final_view', args: { view: 'ranking' } });
    expect(getPrimaryAction(session('FINISHED', 2, 3, { show_leaderboard: true }, { final_view: 'ranking' })).args).toEqual({ view: 'recap' });
    expect(getPrimaryAction(session('FINISHED', 2, 3, { show_leaderboard: true }, { final_view: 'recap' })).action).toBeNull();
    expect(getPrimaryAction(session('FINISHED', 2, 3, { show_leaderboard: false }, { final_view: 'recap' })).action).toBeNull();
  });
});

describe('transitions', () => {
  it('mirrors the server rules', () => {
    expect(TRANSITIONS.LOBBY).toEqual(['start']);
    expect(canPerform(session('LOBBY', -1), 'next')).toBe(false);
    expect(canPerform(session('ANSWER_REVEAL', 2, 3), 'next')).toBe(false);
    expect(canPerform(session('ANSWER_REVEAL', 1, 3), 'next')).toBe(true);
    expect(canPerform(session('QUESTION_OPEN', 0, 3), 'previous')).toBe(false);
    expect(canPerform(session('QUESTION_OPEN', 1, 3), 'previous')).toBe(true);
    expect(canPerform(session('FINISHED', 2, 3), 'finish')).toBe(false);
    expect(canPerform(session('QUESTION_OPEN', 1, 3), 'reset')).toBe(true);
  });
});

describe('isTickDue', () => {
  const now = Date.parse('2026-01-01T00:00:10Z');
  it('ends the starting countdown at stage_ends_at', () => {
    expect(isTickDue(session('STARTING', -1, 3, {}, { stage_ends_at: '2026-01-01T00:00:09Z' }), now)).toBe(true);
    expect(isTickDue(session('STARTING', -1, 3, {}, { stage_ends_at: '2026-01-01T00:00:11Z' }), now)).toBe(false);
  });
  it('closes after the deadline plus grace', () => {
    const s = session('QUESTION_OPEN', 0, 3, {}, { question_deadline_at: '2026-01-01T00:00:09.700Z' });
    expect(isTickDue(s, now)).toBe(false);
    expect(isTickDue(s, now + 400)).toBe(true);
  });
  it('closes early when every eligible player answered', () => {
    const s = session('QUESTION_OPEN', 0, 3, {}, { question_deadline_at: '2026-01-01T00:00:30Z' });
    expect(isTickDue(s, now, { answers_count: 3, eligible_count: 3 })).toBe(true);
    expect(isTickDue(s, now, { answers_count: 2, eligible_count: 3 })).toBe(false);
    expect(isTickDue(s, now, { answers_count: 0, eligible_count: 0 })).toBe(false);
    expect(isTickDue({ ...s, auto_close_when_all_answered: false }, now, { answers_count: 3, eligible_count: 3 })).toBe(false);
  });
  it('never fires while paused', () => {
    expect(isTickDue(session('QUESTION_PAUSED', 0, 3, {}, { question_deadline_at: null }), now)).toBe(false);
  });
});
