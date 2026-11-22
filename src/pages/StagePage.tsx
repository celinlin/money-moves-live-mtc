import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize, Volume2, VolumeX } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { CountdownRing } from '@/components/game/CountdownRing';
import { LeaderboardList } from '@/components/game/LeaderboardList';
import { OptionRows } from '@/components/game/OptionRows';
import { Podium } from '@/components/game/Podium';
import { QrCode } from '@/components/game/QrCode';
import { RecapGrid } from '@/components/game/RecapGrid';
import { StartingCountdown } from '@/components/game/StartingCountdown';
import { StageControlBar } from '@/components/host/StageControlBar';
import { FullPageSpinner } from '@/components/ui/misc';
import { BRAND } from '@/config/brand';
import { useAuth } from '@/hooks/useAuth';
import { useAutoTick } from '@/hooks/useAutoTick';
import { useClockSync, useQuestionCountdown, useStartingCountdown } from '@/hooks/useClock';
import { useGameSession } from '@/hooks/useGameSession';
import { toggleFullscreen, useHostControls, useHostKeyboard } from '@/hooks/useHostControls';
import { isQuestionStage } from '@/lib/stateMachine';
import { isMuted, onMutedChange, play, setMuted } from '@/lib/sound';
import { supabase } from '@/lib/supabase';
import type { GameSession, SessionLive } from '@/lib/types';
import { cn, displayHost, formatPin, joinUrl } from '@/lib/utils';

export default function StagePage() {
  const { sessionCode = '' } = useParams();
  const [params] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(params.get('s'));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (sessionId) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('game_sessions')
        .select('id')
        .eq('game_pin', sessionCode)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!alive) return;
      if (data) setSessionId(data.id);
      else setMissing(true);
    })().catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [sessionCode, sessionId]);

  if (missing) {
    return (
      <div className="flex h-dvh items-center justify-center text-2xl text-muted">
        Aucune partie avec le code {formatPin(sessionCode)}
      </div>
    );
  }
  if (!sessionId) return <FullPageSpinner />;
  return <Stage sessionId={sessionId} />;
}

function Stage({ sessionId }: { sessionId: string }) {
  useClockSync();
  const { user, loading: authLoading } = useAuth();
  const { session, live, notFound, applySession, refetch } = useGameSession(sessionId, { withLive: true, enabled: !authLoading });
  const isHost = Boolean(session && user && !user.is_anonymous && user.id === session.host_id);
  const controls = useHostControls(isHost ? session : null, live, applySession, refetch);
  const [barVisible, setBarVisible] = useState(true);
  useHostKeyboard({ primary: controls.runPrimary, pause: controls.togglePause, extra: { h: () => setBarVisible((v) => !v) } }, isHost);
  useAutoTick(session, live, { role: isHost ? 'host' : 'stage', onResult: applySession });
  usePresenceRefresh(session?.id);
  useStageSounds(session, live);

  if (notFound) return <div className="flex h-dvh items-center justify-center text-2xl text-muted">Partie introuvable</div>;
  if (!session) return <FullPageSpinner />;

  return (
    <div className="glow-bg flex h-dvh w-full flex-col overflow-hidden px-[3.6vw] pb-[2.6vh] pt-[3vh]">
      <StageHeader session={session} live={live} />
      <main className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={stageKey(session)}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0"
          >
            <StageBody session={session} live={live} />
          </motion.div>
        </AnimatePresence>
      </main>
      {isHost && barVisible && <StageControlBar session={session} controls={controls} className="mt-[2vh]" />}
    </div>
  );
}

function stageKey(s: GameSession) {
  if (isQuestionStage(s.current_stage) || s.current_stage === 'ANSWER_REVEAL') return `q-${s.current_question_index}`;
  if (s.current_stage === 'FINISHED') return `f-${s.final_view}`;
  return s.current_stage;
}

function StageHeader({ session, live }: { session: GameSession; live: SessionLive | null }) {
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => onMutedChange(setMutedState), []);
  const inGame = session.current_question_index >= 0 && session.current_stage !== 'FINISHED';
  const connected = live?.connected_count ?? 0;
  return (
    <header className="flex items-center justify-between text-[clamp(0.8rem,0.95vw,1.15rem)]">
      <Wordmark className="text-[clamp(1.1rem,1.5vw,1.9rem)]" />
      <div className="flex items-center gap-[1.6vw] text-muted">
        {inGame && (
          <>
            <span>
              Question <b className="text-fg">{session.current_question_index + 1}</b> / {session.question_count}
            </span>
            <span className="tabular">
              <b className="text-fg">{live?.answers_count ?? 0}</b> / {live?.eligible_count ?? 0} réponses
            </span>
          </>
        )}
        <span className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full', connected > 0 ? 'bg-olive' : 'bg-white/25')} />
          <b className="tabular text-fg">{connected}</b> {connected > 1 ? BRAND.connectedNoun.many : BRAND.connectedNoun.one}
        </span>
        <button type="button" onClick={() => setMuted(!muted)} className="rounded-md p-1 hover:text-fg" aria-label={muted ? 'Activer le son' : 'Couper le son'}>
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
        <button type="button" onClick={toggleFullscreen} className="rounded-md p-1 hover:text-fg" aria-label="Plein écran (F)">
          <Maximize className="size-4" />
        </button>
      </div>
    </header>
  );
}

function StageBody({ session, live }: { session: GameSession; live: SessionLive | null }) {
  const startingSeconds = useStartingCountdown(session);
  switch (session.current_stage) {
    case 'LOBBY':
      return <StageLobby session={session} live={live} />;
    case 'STARTING':
      return <StartingCountdown seconds={startingSeconds} className="h-full" />;
    case 'QUESTION_OPEN':
    case 'QUESTION_PAUSED':
    case 'QUESTION_CLOSED':
    case 'ANSWER_REVEAL':
      return <StageQuestion session={session} live={live} />;
    case 'LEADERBOARD':
      return (
        <div className="mx-auto flex h-full max-w-[62vw] flex-col justify-center">
          <p className="text-[clamp(0.9rem,1.1vw,1.4rem)] text-gold">Après la question {session.current_question_index + 1}</p>
          <h1 className="mb-[4vh] mt-[1vh] text-[clamp(2rem,4.2vw,5.5rem)] font-semibold tracking-tight">Classement</h1>
          <LeaderboardList entries={session.public_state.leaderboard ?? []} limit={5} />
        </div>
      );
    case 'FINISHED':
      return <StageFinal session={session} />;
  }
}

function StageLobby({ session, live }: { session: GameSession; live: SessionLive | null }) {
  const count = live?.participants_count ?? 0;
  const [names, setNames] = useState<string[]>([]);
  const showNames = Boolean(session.public_state.show_leaderboard);
  // Names are only shown for scored quizzes; polls stay anonymous.
  useEffect(() => {
    if (!showNames) return;
    let alive = true;
    supabase
      .from('participants')
      .select('nickname, joined_at')
      .eq('session_id', session.id)
      .eq('removed', false)
      .order('joined_at', { ascending: false })
      .limit(40)
      .then(({ data }) => alive && data && setNames(data.map((d) => d.nickname)));
    return () => {
      alive = false;
    };
  }, [session.id, count, showNames]);

  return (
    <div className="grid h-full grid-cols-[1.25fr_1fr] items-center gap-[4vw]">
      <div>
        <h1 className="text-[clamp(3rem,8.4vw,11rem)] font-semibold leading-[0.95] tracking-[-0.045em]">{BRAND.hero.line1}</h1>
        <p className="font-serif text-[clamp(3.2rem,9vw,12rem)] italic leading-[0.95] tracking-[-0.02em] text-gold">{BRAND.hero.line2}</p>
        <p className="mt-[3vh] text-[clamp(1.1rem,2vw,2.6rem)] text-cream/90">
          <motion.b key={count} initial={{ scale: 1.4 }} animate={{ scale: 1 }} className="tabular inline-block font-semibold text-fg">
            {count}
          </motion.b>{' '}
          {count > 1 ? BRAND.audienceNoun.many : BRAND.audienceNoun.one} · {BRAND.anonymityNote}
        </p>
        {showNames && names.length > 0 && (
          <div className="mt-[3vh] flex max-h-[22vh] flex-wrap gap-2 overflow-hidden">
            <AnimatePresence initial={false}>
              {names.map((n) => (
                <motion.span
                  key={n}
                  layout
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="rounded-full bg-white/[0.07] px-4 py-1.5 text-[clamp(0.9rem,1.2vw,1.5rem)] ring-1 ring-line"
                >
                  {n}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center justify-self-center">
        <QrCode value={joinUrl(session.game_pin)} className="w-[min(26vw,48vh)]" label="Scanne pour rejoindre" />
        <p className="mt-[1.5vh] text-center text-[clamp(0.85rem,1.1vw,1.4rem)] text-subtle">
          ou va sur <span className="text-muted">{displayHost()}</span> · code{' '}
          <span className="tabular font-semibold tracking-wider text-fg">{formatPin(session.game_pin)}</span>
        </p>
      </div>
    </div>
  );
}

function StageQuestion({ session, live }: { session: GameSession; live: SessionLive | null }) {
  const q = session.public_state.question;
  const countdown = useQuestionCountdown(session);
  if (!q) return null;
  const reveal = session.current_stage === 'ANSWER_REVEAL' ? session.public_state.reveal : null;
  const answers = live?.answers_count ?? 0;
  const many = q.options.length > 5;
  const isQuiz = q.kind === 'quiz';

  return (
    <div className="grid h-full grid-cols-[1fr_auto] gap-[4vw]">
      <div className="flex min-w-0 flex-col justify-center">
        <p className="text-[clamp(0.85rem,1.05vw,1.35rem)] text-gold">
          Question {q.index + 1} sur {session.question_count}
          {q.allow_multiple && ' · plusieurs réponses'}
        </p>
        <h1 className={cn('mt-[1.2vh] font-semibold leading-[1.05] tracking-[-0.03em]', many ? 'mb-[3vh] text-[clamp(1.8rem,3.4vw,4.6rem)]' : 'mb-[4.5vh] text-[clamp(2rem,4vw,5.4rem)]')}>
          {q.text}
        </h1>
        <OptionRows options={q.options} results={reveal} dense={many} />
        <p className="mt-[3vh] text-[clamp(0.85rem,1.05vw,1.35rem)] text-muted">
          {reveal
            ? reveal.total_answers === 0
              ? 'Aucune réponse pour cette question'
              : `${reveal.total_answers} réponse${reveal.total_answers > 1 ? 's' : ''}${isQuiz ? ` · ${Math.round((reveal.correct_count / reveal.total_answers) * 100)} % de bonnes réponses` : ''}`
            : session.current_stage === 'QUESTION_CLOSED'
              ? `Réponses fermées · ${answers} réponse${answers > 1 ? 's' : ''}`
              : `${answers} réponse${answers > 1 ? 's' : ''} reçue${answers > 1 ? 's' : ''}…`}
        </p>
        {reveal?.explanation && (
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="mt-[2vh] max-w-[60vw] rounded-2xl bg-card px-[1.4vw] py-[1.4vh] text-[clamp(0.9rem,1.2vw,1.6rem)] leading-snug text-cream/90 ring-1 ring-line"
          >
            {reveal.explanation}
          </motion.p>
        )}
      </div>
      <div className="flex w-[20vw] flex-col items-center justify-center gap-[3vh]">
        {q.image_url && <img src={q.image_url} alt="" className="max-h-[38vh] w-full rounded-3xl object-cover ring-1 ring-line" />}
        {!reveal ? (
          <div className="flex flex-col items-center">
            <CountdownRing seconds={countdown.seconds} fraction={countdown.fraction} paused={countdown.paused} size={Math.round(Math.min(window.innerWidth * 0.1, 200))} />
            {countdown.paused && <p className="mt-[1.5vh] text-[clamp(0.9rem,1.1vw,1.4rem)] text-gold">En pause</p>}
          </div>
        ) : (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center">
            <p className="tabular font-serif text-[clamp(3rem,6vw,8rem)] italic leading-none text-gold">
              {isQuiz ? `${reveal.total_answers ? Math.round((reveal.correct_count / reveal.total_answers) * 100) : 0}%` : reveal.total_answers}
            </p>
            <p className="mt-[1vh] text-[clamp(0.85rem,1.05vw,1.35rem)] text-muted">{isQuiz ? 'de bonnes réponses' : `vote${reveal.total_answers > 1 ? 's' : ''}`}</p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function StageFinal({ session }: { session: GameSession }) {
  const st = session.public_state;
  const lb = st.leaderboard ?? [];
  if (session.final_view === 'podium' && lb.length > 0) {
    return (
      <div className="flex h-full flex-col">
        <h1 className="text-center text-[clamp(1.8rem,3.6vw,4.8rem)] font-semibold tracking-tight">
          Et les <span className="font-serif italic text-gold">gagnantes</span> sont…
        </h1>
        <div className="min-h-0 flex-1 pt-[3vh]">
          <Podium entries={lb} />
        </div>
      </div>
    );
  }
  if (session.final_view === 'ranking' && lb.length > 0) {
    const shown = lb.slice(0, 30);
    return (
      <div className="flex h-full flex-col">
        <h1 className="mb-[3vh] text-[clamp(1.8rem,3.4vw,4.4rem)] font-semibold tracking-tight">Classement final</h1>
        <ol className={cn('grid min-h-0 flex-1 auto-rows-min gap-x-[3vw] gap-y-[1.2vh] overflow-hidden', shown.length > 10 ? 'grid-flow-col grid-rows-10' : '')} style={{ gridTemplateColumns: shown.length > 20 ? 'repeat(3, 1fr)' : shown.length > 10 ? 'repeat(2, 1fr)' : '1fr' }}>
          {shown.map((e, i) => (
            <motion.li
              key={e.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.025 }}
              className={cn('flex items-center gap-[1vw] rounded-xl px-[1vw] py-[0.8vh] text-[clamp(0.9rem,1.25vw,1.7rem)]', e.rank <= 3 ? 'bg-gold-soft' : 'bg-card')}
            >
              <span className="tabular w-[2.5ch] text-right font-semibold text-gold">{e.rank}</span>
              <span className="min-w-0 flex-1 truncate">{e.nickname}</span>
              <span className="tabular font-semibold">{e.score.toLocaleString('fr-FR')}</span>
            </motion.li>
          ))}
        </ol>
        {lb.length > shown.length && <p className="mt-[1vh] text-muted">+ {lb.length - shown.length} autres participantes</p>}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-[2.5vh] text-[clamp(1.8rem,3.4vw,4.4rem)] font-semibold tracking-tight">
        Le <span className="font-serif italic text-gold">récap</span>
      </h1>
      <div className="min-h-0 flex-1 overflow-hidden">
        <RecapGrid recap={st.recap ?? []} />
      </div>
    </div>
  );
}

/** Keep the "connectées" counter fresh (participants ping every 15 s). */
function usePresenceRefresh(sessionId: string | undefined) {
  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => void supabase.rpc('refresh_presence', { p_session_id: sessionId });
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [sessionId]);
}

function useStageSounds(session: GameSession | null, live: SessionLive | null) {
  const lastStage = useRef<string | null>(null);
  const lastCount = useRef<number | null>(null);
  const countdown = useQuestionCountdown(session);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    if (!session) return;
    const key = `${session.current_stage}-${session.current_question_index}`;
    if (lastStage.current && lastStage.current !== key) {
      if (session.current_stage === 'STARTING') play('start');
      if (session.current_stage === 'ANSWER_REVEAL') play('reveal');
      if (session.current_stage === 'LEADERBOARD') play('leaderboard');
    }
    lastStage.current = key;
  }, [session]);

  useEffect(() => {
    const n = live?.participants_count ?? null;
    if (session?.current_stage === 'LOBBY' && lastCount.current != null && n != null && n > lastCount.current) play('join');
    lastCount.current = n;
  }, [live?.participants_count, session?.current_stage]);

  useEffect(() => {
    if (!countdown.running || countdown.seconds > 5 || countdown.seconds <= 0) return;
    if (lastTick.current === countdown.seconds) return;
    lastTick.current = countdown.seconds;
    play('tick');
  }, [countdown.running, countdown.seconds]);
}
