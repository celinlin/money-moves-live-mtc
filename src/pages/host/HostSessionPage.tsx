import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Flag,
  Keyboard,
  ListOrdered,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import { CountdownRing } from '@/components/game/CountdownRing';
import { ConnectionBanner } from '@/components/game/ConnectionBadge';
import { LeaderboardList } from '@/components/game/LeaderboardList';
import { OptionRows } from '@/components/game/OptionRows';
import { ProgressDots } from '@/components/game/ProgressDots';
import { QrCode } from '@/components/game/QrCode';
import { TIMER_OPTIONS } from '@/components/host/StageControlBar';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, FullPageSpinner } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/useAuth';
import { useAutoTick } from '@/hooks/useAutoTick';
import { useClockSync, useQuestionCountdown, useStartingCountdown } from '@/hooks/useClock';
import { useGameSession } from '@/hooks/useGameSession';
import { useHostControls, useHostKeyboard } from '@/hooks/useHostControls';
import { serverNow } from '@/lib/clock';
import { canPerform, isQuestionStage, STAGE_LABELS } from '@/lib/stateMachine';
import { percent } from '@/lib/scoring';
import { supabase } from '@/lib/supabase';
import type { Participant, SessionQuestionPrivate } from '@/lib/types';
import { cn, formatPin, joinUrl, OPTION_LETTERS } from '@/lib/utils';

/** Presenter control room. Everything is restored from the server after a refresh. */
export default function HostSessionPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const { isHost, loading: authLoading, user } = useAuth();
  useClockSync();
  const { session, live, connection, notFound, applySession, refetch } = useGameSession(sessionId, { withLive: true, enabled: isHost });
  const controls = useHostControls(session, live, applySession, refetch);
  const { run, pending, primary, runPrimary, togglePause } = controls;
  useHostKeyboard({ primary: runPrimary, pause: togglePause }, Boolean(session));
  useAutoTick(session, live, { role: 'host', onResult: applySession });
  const participants = useParticipants(isHost ? sessionId : null);
  const questions = useSessionQuestions(isHost ? sessionId : null, session?.state_version);
  const countdown = useQuestionCountdown(session);
  const startingSeconds = useStartingCountdown(session);
  const [confirm, setConfirm] = useState<null | 'finish' | 'reset'>(null);
  const [toRemove, setToRemove] = useState<Participant | null>(null);

  // Keep the "connectées" counter fresh.
  useEffect(() => {
    if (!sessionId || !isHost) return;
    const refresh = () => void supabase.rpc('refresh_presence', { p_session_id: sessionId });
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [sessionId, isHost]);

  // Preload the next question's image so it appears instantly on stage.
  const nextQ = questions?.[(session?.current_question_index ?? -1) + 1];
  useEffect(() => {
    if (nextQ?.image_url) new Image().src = nextQ.image_url;
  }, [nextQ?.image_url]);

  if (authLoading) return <FullPageSpinner />;
  if (!isHost) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted">Connecte-toi pour piloter cette partie.</p>
        <Button asChild><Link to="/host">Se connecter</Link></Button>
      </div>
    );
  }
  if (notFound || (session && session.host_id !== user?.id)) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted">Partie introuvable.</p>
        <Button asChild><Link to="/host">Retour</Link></Button>
      </div>
    );
  }
  if (!session) return <FullPageSpinner label="Restauration de la partie…" />;

  const stage = session.current_stage;
  const current = questions?.find((q) => q.question_index === session.current_question_index) ?? null;
  const url = joinUrl(session.game_pin);
  const stageUrl = `/stage/${session.game_pin}?s=${session.id}`;
  const answers = live?.answers_count ?? 0;
  const eligible = live?.eligible_count ?? 0;
  const connectedIds = new Set(participants.filter((p) => serverNow() - new Date(p.last_seen_at).getTime() < 35_000).map((p) => p.id));
  const activeParticipants = participants.filter((p) => !p.removed);

  const openStage = () => window.open(stageUrl, 'mml-stage', 'noopener=no');

  return (
    <div className="glow-bg min-h-dvh">
      <ConnectionBanner state={connection} className="sticky top-0 z-40" />
      {/* Header */}
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-5 py-3">
          <Button variant="ghost" size="icon" aria-label="Tableau de bord" onClick={() => navigate('/host')}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate font-semibold">{session.quiz_title}</p>
            <p className="text-xs text-muted">
              {session.current_question_index >= 0 ? `Question ${session.current_question_index + 1} / ${session.question_count} · ` : ''}
              <span data-testid="stage-label">{STAGE_LABELS[stage]}</span>
            </p>
          </div>
          <ProgressDots count={session.question_count} current={session.current_question_index} className="hidden lg:flex" />
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wider text-muted">Code</p>
              <p className="tabular text-xl font-semibold tracking-wider" data-testid="game-pin">{formatPin(session.game_pin)}</p>
            </div>
            <Button variant="secondary" onClick={openStage}>
              <Monitor className="size-4" /> Écran de projection
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          {/* Primary action */}
          <Card className="flex flex-wrap items-center gap-5 p-6">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wider text-gold">Étape</p>
              <p className="mt-1 text-2xl font-semibold">{STAGE_LABELS[stage]}</p>
              <p className="mt-1 text-sm text-muted">{stageHint(stage, primary?.label)}</p>
            </div>
            <Button
              size="xl"
              data-primary="true"
              data-testid="primary-action"
              className="min-w-64"
              onClick={runPrimary}
              disabled={!primary?.action || primary.disabled}
              loading={Boolean(pending)}
            >
              {primary?.label}
              <kbd className="ml-1 font-sans text-xs font-normal opacity-50">Espace</kbd>
            </Button>
          </Card>

          {/* Stage-specific panel */}
          <AnimatePresence mode="wait">
            <motion.div key={stage === 'LOBBY' ? 'lobby' : `q-${session.current_question_index}-${stage === 'FINISHED'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {stage === 'LOBBY' && (
                <Card className="grid gap-6 p-6 md:grid-cols-[220px_1fr]">
                  <QrCode value={url} className="w-full max-w-[220px]" />
                  <div className="flex flex-col justify-center">
                    <p className="text-sm text-muted">Les participantes scannent le QR code ou vont sur</p>
                    <p className="mt-1 break-all text-lg font-medium">{url}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard?.writeText(url);
                          toast.success('Lien copié');
                        }}
                      >
                        <Copy className="size-4" /> Copier le lien
                      </Button>
                      <Button variant="secondary" size="sm" asChild>
                        <a href={url} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Tester</a>
                      </Button>
                    </div>
                    <p className="mt-6 text-5xl font-semibold tabular" data-testid="lobby-count">
                      {live?.participants_count ?? 0}
                      <span className="ml-2 text-lg font-normal text-muted">participante{(live?.participants_count ?? 0) > 1 ? 's' : ''}</span>
                    </p>
                  </div>
                </Card>
              )}
              {stage === 'STARTING' && (
                <Card className="flex items-center justify-center p-10">
                  <p className="font-serif text-8xl italic text-gold">{Math.max(1, startingSeconds)}</p>
                </Card>
              )}
              {(isQuestionStage(stage) || stage === 'ANSWER_REVEAL' || stage === 'LEADERBOARD') && current && (
                <Card className="p-6">
                  <div className="flex flex-wrap items-start gap-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="text-gold">Question {current.question_index + 1}</Badge>
                        <Badge>{current.kind === 'quiz' ? 'Quiz noté' : current.allow_multiple ? 'Sondage · plusieurs réponses' : 'Sondage'}</Badge>
                        <Badge>{current.effective_time_limit_sec ?? current.time_limit_sec} s</Badge>
                      </div>
                      <h2 className="mt-3 text-2xl font-semibold leading-tight">{current.question_text}</h2>
                    </div>
                    {isQuestionStage(stage) && <CountdownRing seconds={countdown.seconds} fraction={countdown.fraction} paused={countdown.paused} size={96} />}
                  </div>

                  {/* Live answer progress */}
                  {isQuestionStage(stage) && (
                    <div className="mt-6">
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-muted">Réponses reçues</span>
                        <span className="tabular" data-testid="answer-count">
                          <b className="text-xl">{answers}</b> / {eligible} · {percent(answers, eligible)} %
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-track">
                        <motion.div className="h-full rounded-full bg-gold" animate={{ width: `${percent(answers, eligible)}%` }} transition={{ duration: 0.3 }} />
                      </div>
                    </div>
                  )}

                  <div className="mt-6">
                    {stage === 'ANSWER_REVEAL' || stage === 'LEADERBOARD' ? (
                      <OptionRows
                        size="compact"
                        options={current.options.map((o) => ({ id: o.id, position: o.position, text: o.text }))}
                        results={session.public_state.reveal ?? current.results}
                      />
                    ) : (
                      // Private answer key — only on the presenter screen.
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {current.options.map((o) => (
                          <li key={o.id} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1', o.is_correct ? 'bg-success/10 ring-success/40' : 'ring-line')}>
                            <span className="text-xs font-semibold text-muted">{OPTION_LETTERS[o.position]}</span>
                            <span className="min-w-0 flex-1 truncate">{o.text}</span>
                            {o.is_correct && <Check className="size-4 text-success" aria-label="Bonne réponse" />}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {current.explanation && <p className="mt-4 text-sm text-muted">💡 {current.explanation}</p>}
                  {stage === 'LEADERBOARD' && session.public_state.leaderboard && (
                    <div className="mt-6">
                      <LeaderboardList entries={session.public_state.leaderboard} size="compact" />
                    </div>
                  )}
                </Card>
              )}
              {stage === 'FINISHED' && (
                <Card className="p-6">
                  <h2 className="text-2xl font-semibold">Partie terminée 🎉</h2>
                  <p className="mt-1 text-muted">L’écran affiche : {session.final_view === 'podium' ? 'le podium' : session.final_view === 'ranking' ? 'le classement complet' : 'le récap'}.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {session.public_state.show_leaderboard && (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => void run('final_view', { view: 'podium' }, { versioned: false })}>Podium</Button>
                        <Button variant="secondary" size="sm" onClick={() => void run('final_view', { view: 'ranking' }, { versioned: false })}>Classement complet</Button>
                      </>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => void run('final_view', { view: 'recap' }, { versioned: false })}>Récap</Button>
                    <Button size="sm" asChild>
                      <Link to={`/host/sessions/${session.id}/results`}><BarChart3 className="size-4" /> Résultats détaillés & export</Link>
                    </Button>
                  </div>
                  {session.public_state.leaderboard && session.public_state.leaderboard.length > 0 && (
                    <div className="mt-6">
                      <LeaderboardList entries={session.public_state.leaderboard} limit={10} size="compact" />
                    </div>
                  )}
                </Card>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Secondary controls */}
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={!canPerform(session, 'previous') || Boolean(pending)} onClick={() => void run('previous')}>
                <ChevronLeft className="size-4" /> Précédente
              </Button>
              {stage === 'QUESTION_PAUSED' ? (
                <Button variant="secondary" size="sm" onClick={() => void run('resume')} disabled={Boolean(pending)}>
                  <Play className="size-4" /> Reprendre
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void run('pause')} disabled={stage !== 'QUESTION_OPEN' || Boolean(pending)}>
                  <Pause className="size-4" /> Pause
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={!canPerform(session, 'close') || Boolean(pending)} onClick={() => void run('close')}>
                <Square className="size-4" /> Clore la question
              </Button>
              <Button variant="secondary" size="sm" disabled={!canPerform(session, 'reveal') || Boolean(pending)} onClick={() => void run('reveal')}>
                <BarChart3 className="size-4" /> Révéler
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canPerform(session, 'leaderboard') || !session.public_state.show_leaderboard || Boolean(pending)}
                onClick={() => void run('leaderboard')}
              >
                <ListOrdered className="size-4" /> Classement
              </Button>
              <Button variant="secondary" size="sm" disabled={!canPerform(session, 'next') || Boolean(pending)} onClick={() => void run('next')}>
                <SkipForward className="size-4" /> Suivante
              </Button>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" disabled={stage === 'FINISHED'} onClick={() => setConfirm('finish')}>
                  <Flag className="size-4" /> Terminer
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirm('reset')}>
                  <RotateCcw className="size-4" /> Réinitialiser
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-4 text-sm">
              <label className="flex items-center gap-2 text-muted">
                Minuteur
                <Select
                  ariaLabel="Durée des questions"
                  value={session.time_override_sec ? String(session.time_override_sec) : 'auto'}
                  onValueChange={(v) => void run('set_timer', { seconds: v === 'auto' ? null : Number(v) }, { versioned: false })}
                  options={TIMER_OPTIONS}
                  className="h-9"
                />
              </label>
              <label className="flex items-center gap-2 text-muted">
                <Switch checked={session.auto_close_when_all_answered} onCheckedChange={(v) => void run('set_auto_close', { enabled: v }, { versioned: false })} />
                Clore dès que tout le monde a répondu
              </label>
              <span className="ml-auto flex items-center gap-2 text-xs text-subtle">
                <Keyboard className="size-3.5" /> Espace / Entrée : action · P : pause · F : plein écran
              </span>
            </div>
          </Card>

          {nextQ && stage !== 'FINISHED' && (
            <p className="px-1 text-sm text-subtle">
              Ensuite : <span className="text-muted">Q{nextQ.question_index + 1} — {nextQ.question_text}</span>
            </p>
          )}
        </div>

        {/* Participants */}
        <aside>
          <Card className="sticky top-6 p-0">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="font-semibold">Participantes</h2>
              <span className="text-sm text-muted">
                <span className="tabular text-fg">{live?.connected_count ?? connectedIds.size}</span> connectées / {activeParticipants.length}
              </span>
            </div>
            <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto scrollbar-thin" data-testid="participant-list">
              <AnimatePresence initial={false}>
                {[...activeParticipants]
                  .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.joined_at.localeCompare(b.joined_at))
                  .map((p) => (
                    <motion.li
                      key={p.id}
                      layout
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="group flex items-center gap-3 px-5 py-2.5 text-sm"
                    >
                      <span className={cn('size-2 shrink-0 rounded-full', connectedIds.has(p.id) ? 'bg-olive' : 'bg-white/20')} title={connectedIds.has(p.id) ? 'Connectée' : 'Déconnectée'} />
                      {p.rank && session.public_state.show_leaderboard && <span className="tabular w-5 text-xs text-gold">{p.rank}</span>}
                      <span className="min-w-0 flex-1 truncate">{p.nickname}</span>
                      {session.public_state.show_leaderboard && <span className="tabular text-xs text-muted">{p.total_score}</span>}
                      <button
                        type="button"
                        className="rounded p-1 text-subtle opacity-0 transition hover:text-danger focus:opacity-100 group-hover:opacity-100"
                        aria-label={`Retirer ${p.nickname}`}
                        onClick={() => setToRemove(p)}
                      >
                        <UserX className="size-3.5" />
                      </button>
                    </motion.li>
                  ))}
              </AnimatePresence>
              {activeParticipants.length === 0 && <li className="px-5 py-8 text-center text-sm text-subtle">En attente des premières arrivées…</li>}
            </ul>
          </Card>
        </aside>
      </main>

      <ConfirmDialog
        open={confirm === 'finish'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Terminer la partie ?"
        description="Les réponses déjà reçues sont comptées, puis les résultats finaux s’affichent. Les participantes ne pourront plus répondre."
        confirmLabel="Terminer la partie"
        onConfirm={() => void run('finish', {}, { versioned: false })}
      />
      <ConfirmDialog
        open={confirm === 'reset'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Réinitialiser la partie ?"
        description="Retour à la salle d’attente : toutes les réponses et tous les scores de cette partie sont effacés. Les participantes restent connectées."
        confirmLabel="Réinitialiser"
        danger
        onConfirm={() => void run('reset', {}, { versioned: false })}
      />
      <ConfirmDialog
        open={Boolean(toRemove)}
        onOpenChange={(o) => !o && setToRemove(null)}
        title={`Retirer ${toRemove?.nickname} ?`}
        description="Elle ne pourra plus répondre dans cette partie et disparaîtra du classement."
        confirmLabel="Retirer"
        danger
        onConfirm={() => toRemove && void run('remove_participant', { participant_id: toRemove.id }, { versioned: false })}
      />
    </div>
  );
}

function stageHint(stage: string, next?: string) {
  switch (stage) {
    case 'LOBBY':
      return 'Les participantes rejoignent la partie. Lance quand tout le monde est là.';
    case 'QUESTION_OPEN':
      return 'Les réponses arrivent. La question se ferme automatiquement à la fin du minuteur.';
    case 'QUESTION_PAUSED':
      return 'Minuteur en pause pour tout le monde. P pour reprendre.';
    case 'QUESTION_CLOSED':
      return 'Réponses fermées. Révèle quand tu es prête.';
    case 'FINISHED':
      return 'Merci ! Les résultats restent affichés sur les téléphones.';
    default:
      return next ? `Prochaine étape : ${next}.` : '';
  }
}

function useParticipants(sessionId: string | null) {
  const [rows, setRows] = useState<Participant[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const load = useCallback(async () => {
    if (!sessionId) return;
    const { data } = await supabase.from('participants').select('*').eq('session_id', sessionId).order('joined_at');
    if (data) setRows(data as Participant[]);
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    void load();
    // Debounced refresh on any participant change (joins, heartbeats, scores).
    const channel = supabase
      .channel(`participants:${sessionId}:${Math.random().toString(36).slice(2, 7)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: `session_id=eq.${sessionId}` }, () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 400);
      })
      .subscribe();
    const poll = setInterval(() => void load(), 15_000);
    return () => {
      clearTimeout(timer.current);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [sessionId, load]);
  return rows;
}

function useSessionQuestions(sessionId: string | null, version?: number) {
  const [rows, setRows] = useState<SessionQuestionPrivate[] | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    void supabase
      .from('session_questions')
      .select('*')
      .eq('session_id', sessionId)
      .order('question_index')
      .then(({ data }) => data && setRows(data as SessionQuestionPrivate[]));
  }, [sessionId, version]);
  return useMemo(() => rows, [rows]);
}
