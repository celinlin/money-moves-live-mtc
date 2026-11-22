import { describe, expect, it } from 'vitest';
import { estimateOffset } from '@/lib/clock';
import { resultsToCsv } from '@/lib/resultsExport';
import type { Participant, SessionQuestionPrivate } from '@/lib/types';

describe('clock offset', () => {
  it('estimates the server offset from a round trip', () => {
    // Local sends at 1000, server stamps 6050, local receives at 1100 → offset ≈ 5000.
    expect(estimateOffset(1000, 6050, 1100)).toEqual({ rtt: 100, offset: 5000 });
  });
});

describe('results CSV', () => {
  const p = (id: string, nickname: string, rank: number, score: number): Participant => ({
    id, session_id: 's', nickname, total_score: score, correct_answers_count: score ? 1 : 0, correct_time_ms: 0,
    rank, previous_rank: null, eligible_from_index: 0, removed: false, joined_at: '2026-01-01T10:00:00Z', last_seen_at: '',
  });
  const q: SessionQuestionPrivate = {
    id: 'q', session_id: 's', question_index: 0, kind: 'quiz', allow_multiple: false, question_text: 'ETF ?', image_url: null,
    time_limit_sec: 20, explanation: null, effective_time_limit_sec: 20, opened_at: 'x', closed_at: 'x', revealed: true,
    options: [{ id: 'o1', position: 0, text: 'Fund', is_correct: true }, { id: 'o2', position: 1, text: 'Tax', is_correct: false }],
    results: { total_answers: 2, correct_count: 1, counts: { o1: 1, o2: 1 }, correct_option_ids: ['o1'], explanation: null },
  };
  it('contains the ranking and per-question distribution', () => {
    const csv = resultsToCsv({ quizTitle: 'Quiz', date: 'today', participants: [p('b', 'Bea', 2, 0), p('a', 'Alice', 1, 900)], questions: [q] });
    const lines = csv.split('\n');
    expect(lines.findIndex((l) => l.startsWith('1,Alice,900'))).toBeLessThan(lines.findIndex((l) => l.startsWith('2,Bea')));
    expect(csv).toContain('ETF ?,quiz,Fund,oui,1,50%,2,50%');
  });
});
