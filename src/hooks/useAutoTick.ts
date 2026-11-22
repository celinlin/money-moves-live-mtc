// Ask the server to perform time-driven transitions (end of the 3-2-1 countdown,
// question deadline reached, everyone answered). The server re-validates with
// its own clock, so calling early or concurrently is harmless; we just avoid
// spamming. Participants wait a random extra delay so that the host / stage
// normally do it, while the game still progresses if the presenter's tab dies.
import { useEffect, useRef } from 'react';
import { serverNow } from '@/lib/clock';
import { isTickDue } from '@/lib/stateMachine';
import { supabase } from '@/lib/supabase';
import type { GameSession, SessionLive } from '@/lib/types';

export function useAutoTick(
  session: GameSession | null,
  live: SessionLive | null,
  opts: { role: 'host' | 'stage' | 'player'; onResult?: (row: GameSession) => void },
) {
  const lastCall = useRef(0);
  const jitter = useRef(opts.role === 'player' ? 1500 + Math.random() * 2500 : opts.role === 'stage' ? 300 : 0);
  const onResult = useRef(opts.onResult);
  onResult.current = opts.onResult;

  useEffect(() => {
    if (!session) return;
    if (session.current_stage !== 'STARTING' && session.current_stage !== 'QUESTION_OPEN') return;
    const id = setInterval(async () => {
      const now = serverNow();
      if (!isTickDue(session, now - jitter.current, live)) return;
      if (now - lastCall.current < 1000) return;
      lastCall.current = now;
      const { data } = await supabase.rpc('tick_session', { p_session_id: session.id });
      if (data) onResult.current?.(data as GameSession);
    }, 150);
    return () => clearInterval(id);
  }, [session, live]);
}
