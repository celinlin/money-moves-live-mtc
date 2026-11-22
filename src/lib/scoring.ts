// Client mirror of the server scoring rules. The database is authoritative;
// these functions exist for display, previews and unit tests, and must match
// public.compute_points / public._recompute_scores.

export const MIN_POINTS = 500;
export const MAX_POINTS = 1000;

export function computePoints(remainingMs: number, durationMs: number): number {
  if (!durationMs || durationMs <= 0) return MIN_POINTS;
  const r = Math.min(Math.max(remainingMs, 0), durationMs);
  return MIN_POINTS + Math.round((500 * r) / durationMs);
}

export interface RankInput {
  id: string;
  score: number;
  correctCount: number;
  correctTimeMs: number;
  joinedAt: string;
}

/** Deterministic ranking: score ↓, correct answers ↓, total correct response time ↑, join time ↑, id ↑. */
export function rankParticipants<T extends RankInput>(rows: T[]): (T & { rank: number })[] {
  return [...rows]
    .sort((a, b) =>
      b.score - a.score ||
      b.correctCount - a.correctCount ||
      a.correctTimeMs - b.correctTimeMs ||
      a.joinedAt.localeCompare(b.joinedAt) ||
      a.id.localeCompare(b.id),
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export function rankMovement(rank: number | null, previous: number | null): number {
  if (rank == null || previous == null) return 0;
  return previous - rank; // positive = moved up
}

export function percent(count: number, total: number): number {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}
