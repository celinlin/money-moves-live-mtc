import { describe, expect, it } from 'vitest';
import { computePoints, percent, rankMovement, rankParticipants } from '@/lib/scoring';

describe('computePoints', () => {
  it('awards 500 + up to 500 speed bonus', () => {
    expect(computePoints(20000, 20000)).toBe(1000);
    expect(computePoints(10000, 20000)).toBe(750);
    expect(computePoints(0, 20000)).toBe(500);
  });
  it('clamps out-of-range values', () => {
    expect(computePoints(-100, 20000)).toBe(500);
    expect(computePoints(99999, 20000)).toBe(1000);
    expect(computePoints(5000, 0)).toBe(500);
  });
  it('rounds to the nearest point', () => {
    expect(computePoints(3333, 10000)).toBe(667);
  });
});

describe('rankParticipants', () => {
  const base = { correctTimeMs: 0, joinedAt: '2026-01-01T00:00:00Z' };
  it('sorts by score, then correct answers, then response time, then join time, then id', () => {
    const ranked = rankParticipants([
      { id: 'a', score: 900, correctCount: 1, ...base, correctTimeMs: 4000 },
      { id: 'b', score: 900, correctCount: 1, ...base, correctTimeMs: 3000 },
      { id: 'c', score: 900, correctCount: 2, ...base },
      { id: 'd', score: 1500, correctCount: 2, ...base },
      { id: 'f', score: 0, correctCount: 0, ...base },
      { id: 'e', score: 0, correctCount: 0, ...base },
      { id: 'g', score: 0, correctCount: 0, correctTimeMs: 0, joinedAt: '2025-12-31T00:00:00Z' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['d', 'c', 'b', 'a', 'g', 'e', 'f']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('is deterministic regardless of input order', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, score: i % 3, correctCount: i % 2, correctTimeMs: i % 4, joinedAt: base.joinedAt }));
    const a = rankParticipants(rows).map((r) => r.id);
    const b = rankParticipants([...rows].reverse()).map((r) => r.id);
    expect(a).toEqual(b);
  });
});

describe('helpers', () => {
  it('rankMovement is positive when moving up', () => {
    expect(rankMovement(2, 5)).toBe(3);
    expect(rankMovement(5, 2)).toBe(-3);
    expect(rankMovement(1, null)).toBe(0);
  });
  it('percent handles zero totals', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(2, 3)).toBe(67);
  });
});
