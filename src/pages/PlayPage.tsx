import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Wordmark } from '@/components/brand/Wordmark';
import { ConnectionBanner } from '@/components/game/ConnectionBadge';
import { StartingCountdown } from '@/components/game/StartingCountdown';
import { JoinForm } from '@/components/play/JoinForm';
import {
  AnsweredScreen,
  FinalScreen,
  LeaderboardScreen,
  LobbyScreen,
  QuestionScreen,
  RemovedScreen,
  RevealScreen,
  SpectatorScreen,
  TimeUpScreen,
} from '@/components/play/PlayerScreens';
import { Button } from '@/components/ui/button';
import { FullPageSpinner } from '@/components/ui/misc';
import { useAutoTick } from '@/hooks/useAutoTick';
import { useClockSync, useQuestionCountdown, useStartingCountdown } from '@/hooks/useClock';
import { useGameSession } from '@/hooks/useGameSession';
import { recordSample } from '@/lib/clock';
import { errorCode, friendlyError, isNetworkError } from '@/lib/errors';
import { play, vibrate } from '@/lib/sound';
import { ensureSession, rpc, supabase } from '@/lib/supabase';
import type { GameSession, PlayerState } from '@/lib/types';

type Phase = { kind: 'boot' } | { kind: 'notfound' } | { kind: 'join'; sessionId: string } | { kind: 'game'; sessionId: string } | { kind: 'error'; message: string };

export default function PlayPage() {
  const { sessionCode = '' } = useParams();
  const pin = sessionCode.replace(/\D/g, '').slice(0, 6);
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' });

  const boot = useCallback(async () => {
    setPhase({ kind: 'boot' });
    try {
      await ensureSession();
      const found = await rpc<{ id: string } | null>('lookup_session', { p_pin: pin });
      let sessionId = found?.id ?? null;
      if (!sessionId) {
        // A finished game is no longer joinable, but players who were in it can stay on their results.
        try {
          sessionId = localStorage.getItem(`mml-session:${pin}`);
        } catch {
          sessionId = null;
        }
      }
      if (!sessionId) return setPhase({ kind: 'notfound' });
      const state = await rpc<PlayerState>('player_state', { p_session_id: sessionId });
      if (state.joined) setPhase({ kind: 'game', sessionId });
      else if (found) setPhase({ kind: 'join', sessionId });
      else setPhase({ kind: 'notfound' });
    } catch (err) {
      setPhase({ kind: 'error', message: friendlyError(err) });
    }
  }, [pin]);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (phase.kind === 'boot') return <FullPageSpinner label="Connexion à la partie…" />;
  if (phase.kind === 'error' || phase.kind === 'notfound') {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <h1 className="text-2xl font-semibold">{phase.kind === 'notfound' ? 'Partie introuvable' : 'Oups'}</h1>
          <p className="max-w-xs text-muted">
            {phase.kind === 'notfound' ? `Aucune partie en cours avec le code ${pin}. Vérifie le code affiché à l’écran.` : phase.message}
          </p>
          <div className="flex gap-2">
            {phase.kind === 'error' && <Button onClick={() => void boot()}>Réessayer</Button>}
            <Button variant="secondary" asChild>
              <Link to="/">Entrer un code</Link>
            </Button>
          </div>
        </div>
      </Shell>
    );
  }
  if (phase.kind === 'join') {
    return (
      <Shell>
        <div className="flex flex-1 items-center">
          <JoinForm pin={pin} onJoined={(res) => setPhase({ kind: 'game', sessionId: res.session_id })} />
        </div>
      </Shell>
    );
  }
  return <PlayerGame sessionId={phase.sessionId} />;
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <main className="glow-bg flex min-h-dvh flex-col px-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-[max(env(safe-area-inset-top),1.25rem)]">
      <header className="mx-auto flex w-full max-w-md items-center justify-between">
        <Wordmark className="text-lg" />
        {right}
      </header>
      {children}
    </main>
  );
}

interface LocalAnswer {
  questionIndex: number;
  optionIds: string[];
  status: 'sending' | 'sent' | 'error';
  error?: string;
}

function PlayerGame({ sessionId }: { sessionId: string }) {
  useClockSync();
  const { session, connection, applySession } = useGameSession(sessionId);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [local, setLocal] = useState<LocalAnswer | null>(null);
  const countdown = useQuestionCountdown(session);
  const startingSeconds = useStartingCountdown(session);
  useAutoTick(session, null, { role: 'player', onResult: (row) => applySession(row) });

  const fetchPlayer = useCallback(async () => {
    try {
      const s = await rpc<PlayerState>('player_state', { p_session_id: sessionId });
      setPlayer(s);
    } catch {
      /* transient; retried on next state change / poll */
    }
  }, [sessionId]);

  // Refresh personal state on every game transition (small random spread so a
  // full room does not hit the database in the same millisecond).
  const version = session?.state_version;
  useEffect(() => {
    if (version == null) return;
    const t = setTimeout(() => void fetchPlayer(), Math.random() * 250);
    return () => clearTimeout(t);
  }, [version, fetchPlayer]);

  // Lobby: refresh the participant count periodically.
  const stage = session?.current_stage;
  useEffect(() => {
    if (stage !== 'LOBBY') return;
    const id = setInterval(() => void fetchPlayer(), 4000);
    return () => clearInterval(id);
  }, [stage, fetchPlayer]);

  // Heartbeat: keeps the presence indicator accurate and refines the clock offset.
  useEffect(() => {
    const beat = async () => {
      const t0 = Date.now();
      const { data } = await supabase.rpc('heartbeat', { p_session_id: sessionId });
      if (data) recordSample(t0, new Date(data as string).getTime(), Date.now());
    };
    void beat();
    const id = setInterval(() => void beat(), 15_000);
    const onVisible = () => document.visibilityState === 'visible' && void beat();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId]);

  // Reset the local answer when a new question starts; restore it after a reconnect.
  const qIndex = session?.current_question_index ?? -1;
  useEffect(() => {
    setLocal((l) => (l && l.questionIndex !== qIndex ? null : l));
  }, [qIndex]);
  useEffect(() => {
    const a = player?.answer;
    if (a && a.question_index === qIndex) {
      setLocal((l) => (l?.status === 'sent' ? l : { questionIndex: qIndex, optionIds: a.selected_option_ids, status: 'sent' }));
    }
  }, [player, qIndex]);

  // Feedback on reveal.
  const revealKey = stage === 'ANSWER_REVEAL' ? `${qIndex}` : null;
  const lastReveal = useRef<string | null>(null);
  useEffect(() => {
    if (!revealKey || !player?.answer || player.answer.question_index !== qIndex || lastReveal.current === revealKey) return;
    if (player.answer.is_correct == null) return;
    lastReveal.current = revealKey;
    if (player.answer.is_correct) {
      vibrate([30, 40, 60]);
      play('correct');
    } else {
      vibrate(80);
    }
  }, [revealKey, player, qIndex]);

  const submit = useCallback(
    async (optionIds: string[]) => {
      if (!session) return;
      const questionIndex = session.current_question_index;
      vibrate(15);
      play('tap');
      setLocal({ questionIndex, optionIds, status: 'sending' });
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await rpc<{ selected_option_ids: string[] }>('submit_answer', {
            p_session_id: session.id,
            p_question_index: questionIndex,
            p_option_ids: optionIds,
          });
          setLocal({ questionIndex, optionIds: res.selected_option_ids ?? optionIds, status: 'sent' });
          return;
        } catch (err) {
          if (isNetworkError(err) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          const code = errorCode(err);
          setLocal({ questionIndex, optionIds, status: 'error', error: friendlyError(err) });
          if (code === 'QUESTION_CLOSED' || code === 'QUESTION_NOT_ACTIVE') {
            const { data } = await supabase.from('game_sessions').select('*').eq('id', session.id).maybeSingle();
            if (data) applySession(data as GameSession);
          }
          return;
        }
      }
    },
    [session, applySession],
  );

  if (!session || !player) return <FullPageSpinner label="Synchronisation…" />;
  if (player.removed) return <Shell><RemovedScreen /></Shell>;

  const me = player.participant!;
  const q = session.public_state.question;
  const showScore = Boolean(session.public_state.show_leaderboard);
  const eligible = me.eligible_from_index <= qIndex;
  const answeredThis = local && local.questionIndex === qIndex ? local : null;

  let screen: React.ReactNode;
  switch (session.current_stage) {
    case 'LOBBY':
      screen = <LobbyScreen nickname={me.nickname} count={player.participants_count ?? 0} />;
      break;
    case 'STARTING':
      screen = <StartingCountdown seconds={startingSeconds} className="flex-1" />;
      break;
    case 'QUESTION_OPEN':
    case 'QUESTION_PAUSED':
      if (!q) screen = null;
      else if (!eligible) screen = <SpectatorScreen question={q} />;
      else if (answeredThis && answeredThis.status !== 'error') screen = <AnsweredScreen question={q} answer={answeredThis} paused={countdown.paused} />;
      else if (countdown.remainingMs <= 0 && !countdown.paused) screen = <TimeUpScreen answered={false} />;
      else
        screen = (
          <QuestionScreen
            key={q.index}
            question={q}
            total={session.question_count}
            countdown={countdown}
            onSubmit={submit}
            error={answeredThis?.status === 'error' ? answeredThis.error : undefined}
            sending={false}
          />
        );
      break;
    case 'QUESTION_CLOSED':
      screen = answeredThis?.status === 'sent' && q ? <AnsweredScreen question={q} answer={answeredThis} closed /> : <TimeUpScreen answered={false} />;
      break;
    case 'ANSWER_REVEAL':
      screen = q ? <RevealScreen question={q} state={session.public_state} player={player} eligible={eligible} showScore={showScore} /> : null;
      break;
    case 'LEADERBOARD':
      screen = <LeaderboardScreen player={player} entries={session.public_state.leaderboard ?? []} />;
      break;
    case 'FINISHED':
      screen = <FinalScreen player={player} state={session.public_state} />;
      break;
  }

  return (
    <>
      <ConnectionBanner state={connection} className="fixed inset-x-0 top-0 z-40" />
      <Shell
        right={
          showScore && session.current_stage !== 'LOBBY' ? (
            <span className="tabular rounded-full bg-white/[0.07] px-3 py-1 text-sm font-medium ring-1 ring-line" aria-label="Ton score">
              {me.total_score.toLocaleString('fr-FR')} pts
            </span>
          ) : (
            <span className="max-w-[45%] truncate text-sm text-muted">{me.nickname}</span>
          )
        }
      >
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col">{screen}</div>
      </Shell>
    </>
  );
}
