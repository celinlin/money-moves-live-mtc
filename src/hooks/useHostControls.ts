import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorCode, friendlyError } from '@/lib/errors';
import { getPrimaryAction, type HostAction } from '@/lib/stateMachine';
import { supabase } from '@/lib/supabase';
import type { GameSession, SessionLive } from '@/lib/types';
import { isTypingTarget } from '@/lib/utils';

/**
 * Presenter commands with double-click protection: one command in flight at a
 * time, and each command carries the state_version it was based on, so a
 * second tab or a repeated keypress can never apply a transition twice.
 */
export function useHostControls(
  session: GameSession | null,
  live: SessionLive | null,
  applySession: (row: GameSession) => void,
  refetch: () => Promise<void> | void,
) {
  const [pending, setPending] = useState<HostAction | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (action: HostAction, args: Record<string, unknown> = {}, { versioned = true } = {}) => {
      if (!session || busy.current) return false;
      busy.current = true;
      setPending(action);
      try {
        const { data, error } = await supabase.rpc('host_action', {
          p_session_id: session.id,
          p_action: action,
          p_expected_version: versioned ? session.state_version : null,
          p_args: args,
        });
        if (error) throw error;
        applySession(data as GameSession);
        return true;
      } catch (err) {
        const code = errorCode(err);
        if (code === 'STALE_STATE' || code === 'INVALID_TRANSITION') {
          // Someone (another tab, or the timer) already moved the game: just resync.
          await refetch();
        } else {
          toast.error(friendlyError(err));
        }
        return false;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [session, applySession, refetch],
  );

  const primary = session ? getPrimaryAction(session, live) : null;

  const runPrimary = useCallback(() => {
    if (!primary?.action || primary.disabled) return;
    void run(primary.action, primary.args ?? {});
  }, [primary, run]);

  const togglePause = useCallback(() => {
    if (!session) return;
    if (session.current_stage === 'QUESTION_OPEN') void run('pause');
    else if (session.current_stage === 'QUESTION_PAUSED') void run('resume');
  }, [session, run]);

  return { run, pending, primary, runPrimary, togglePause };
}

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** Space / Enter = primary action, P = pause/resume, F = fullscreen. Ignored while typing. */
export function useHostKeyboard(handlers: { primary: () => void; pause: () => void; extra?: Record<string, () => void> }, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.repeat) return; // holding a key must not fire repeated transitions
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'enter') {
        // Do not hijack Enter/Space on focused buttons other than our own primary button.
        const el = e.target as HTMLElement;
        if (el?.tagName === 'BUTTON' && !el.dataset.primary) return;
        e.preventDefault();
        ref.current.primary();
      } else if (key === 'p') {
        e.preventDefault();
        ref.current.pause();
      } else if (key === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else if (ref.current.extra?.[key]) {
        e.preventDefault();
        ref.current.extra[key]();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
