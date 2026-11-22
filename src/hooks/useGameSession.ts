// Real-time session synchronisation.
//
// Strategy: snapshot + realtime + safety net.
//  1. Fetch the authoritative row on mount and whenever the channel (re)subscribes.
//  2. Apply realtime UPDATE events, but only if state_version is newer
//     (out-of-order or duplicate events can never move the UI backwards).
//  3. Poll as a safety net: slowly while realtime is healthy, quickly when it is not,
//     and immediately when the tab becomes visible or the network comes back.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { GameSession, SessionLive } from '@/lib/types';

export type ConnectionState = 'connecting' | 'live' | 'degraded' | 'offline';

interface Options {
  /** Also subscribe to live counters (answers / participants). Host + stage only. */
  withLive?: boolean;
  enabled?: boolean;
}

const HEALTHY_POLL_MS = 10_000;
const DEGRADED_POLL_MS = 2_000;

export function useGameSession(sessionId: string | null | undefined, { withLive = false, enabled = true }: Options = {}) {
  const [session, setSession] = useState<GameSession | null>(null);
  const [live, setLive] = useState<SessionLive | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [notFound, setNotFound] = useState(false);
  const versionRef = useRef(0);
  const liveStampRef = useRef('');
  const inFlight = useRef<Promise<void> | null>(null);

  const applySession = useCallback((row: GameSession | null | undefined) => {
    if (!row || typeof row.state_version !== 'number') return false;
    const v = Number(row.state_version);
    if (v <= versionRef.current) return false;
    versionRef.current = v;
    setSession(row);
    return true;
  }, []);

  const applyLive = useCallback((row: SessionLive | null | undefined) => {
    if (!row) return;
    // Counters only grow within a question; updated_at orders events.
    if (row.updated_at && row.updated_at < liveStampRef.current) return;
    liveStampRef.current = row.updated_at ?? liveStampRef.current;
    setLive(row);
  }, []);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [{ data, error }, liveRes] = await Promise.all([
          supabase.from('game_sessions').select('*').eq('id', sessionId).maybeSingle(),
          withLive
            ? supabase.from('session_live').select('*').eq('session_id', sessionId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        if (error) throw error;
        if (!data) {
          setNotFound(true);
          return;
        }
        setNotFound(false);
        applySession(data as GameSession);
        if (liveRes.data) applyLive(liveRes.data as SessionLive);
        if (!navigator.onLine) setConnection('offline');
      } catch {
        setConnection((c) => (navigator.onLine ? (c === 'live' ? 'degraded' : c) : 'offline'));
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [sessionId, withLive, applySession, applyLive]);

  // Realtime channel with automatic resubscription.
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let channel: RealtimeChannel | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const subscribe = () => {
      if (disposed) return;
      channel = supabase.channel(`session:${sessionId}:${Math.random().toString(36).slice(2, 8)}`);
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as GameSession;
          // Large JSON values can be omitted from change events; fall back to a fetch.
          if (!row.public_state || !('quiz_title' in row.public_state)) void refetch();
          else applySession(row);
        },
      );
      if (withLive) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'session_live', filter: `session_id=eq.${sessionId}` },
          (payload) => applyLive(payload.new as SessionLive),
        );
      }
      channel.subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          setConnection('live');
          void refetch(); // close any gap while we were not subscribed
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnection(navigator.onLine ? 'degraded' : 'offline');
          const ch = channel;
          channel = null;
          if (ch) void supabase.removeChannel(ch);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(subscribe, Math.min(1000 * 2 ** attempt++, 15_000));
        }
      });
    };

    void refetch();
    subscribe();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [sessionId, enabled, withLive, refetch, applySession, applyLive]);

  // Safety-net polling.
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const ms = connection === 'live' ? HEALTHY_POLL_MS : DEGRADED_POLL_MS;
    const id = setInterval(() => void refetch(), ms);
    return () => clearInterval(id);
  }, [sessionId, enabled, connection, refetch]);

  // Recover instantly when the tab returns to the foreground or the network comes back.
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    const onOnline = () => {
      setConnection('degraded');
      void refetch();
    };
    const onOffline = () => setConnection('offline');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onVisible);
    };
  }, [sessionId, enabled, refetch]);

  return { session, live, connection, notFound, refetch, applySession };
}
