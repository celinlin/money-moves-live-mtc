import { useEffect, useState } from 'react';
import { remainingMs, serverNow, syncClock } from '@/lib/clock';
import type { GameSession } from '@/lib/types';

/** Keep the server clock offset fresh while mounted. */
export function useClockSync() {
  useEffect(() => {
    void syncClock();
    const id = setInterval(() => void syncClock(2), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void syncClock(2);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

/** Re-render every `interval` ms while `active`, returning the server time. */
export function useServerNow(active: boolean, interval = 200) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    if (!active) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), interval);
    return () => clearInterval(id);
  }, [active, interval]);
  return now;
}

export interface CountdownInfo {
  remainingMs: number;
  totalMs: number;
  seconds: number;
  fraction: number; // 1 → 0
  paused: boolean;
  running: boolean;
}

/** Authoritative question countdown derived from the session row. */
export function useQuestionCountdown(session: GameSession | null): CountdownInfo {
  const stage = session?.current_stage;
  const running = stage === 'QUESTION_OPEN';
  useServerNow(running, 200);
  const totalMs = session?.public_state.question?.time_limit_ms ?? 0;
  let rem = 0;
  if (stage === 'QUESTION_OPEN') rem = remainingMs(session!.question_deadline_at);
  else if (stage === 'QUESTION_PAUSED') rem = session!.paused_remaining_ms ?? 0;
  const seconds = Math.ceil(rem / 1000);
  return {
    remainingMs: rem,
    totalMs,
    seconds,
    fraction: totalMs > 0 ? Math.min(1, rem / totalMs) : 0,
    paused: stage === 'QUESTION_PAUSED',
    running: running && rem > 0,
  };
}

/** Seconds left in the STARTING "3, 2, 1" countdown. */
export function useStartingCountdown(session: GameSession | null) {
  const active = session?.current_stage === 'STARTING';
  useServerNow(active, 100);
  if (!active || !session?.stage_ends_at) return 0;
  return Math.ceil(remainingMs(session.stage_ends_at) / 1000);
}
