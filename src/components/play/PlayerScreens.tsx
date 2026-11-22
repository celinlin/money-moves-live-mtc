import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDown, ArrowUp, Check, Clock, Hourglass, Pause, Sparkles, Trophy, X } from 'lucide-react';
import { OptionRows } from '@/components/game/OptionRows';
import { RecapGrid } from '@/components/game/RecapGrid';
import { Button } from '@/components/ui/button';
import type { CountdownInfo } from '@/hooks/useClock';
import { BRAND } from '@/config/brand';
import { rankMovement } from '@/lib/scoring';
import type { LeaderboardEntry, PlayerState, PublicQuestion, PublicState } from '@/lib/types';
import { cn, OPTION_LETTERS, optionColor } from '@/lib/utils';

const ordinal = (n: number) => (n === 1 ? '1re' : `${n}e`);

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn('flex flex-1 flex-col items-center justify-center py-8 text-center', className)}
    >
      {children}
    </motion.div>
  );
}

function Coins() {
  return (
    <div className="relative mb-8 h-24 w-32" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute flex size-14 items-center justify-center rounded-full bg-gold font-serif text-2xl italic text-plum-deep shadow-lg"
          style={{ left: i * 34, top: 20 }}
          animate={{ y: [0, -14, 0] }}
          transition={{ repeat: Infinity, duration: 1.6, delay: i * 0.22, ease: 'easeInOut' }}
        >
          €
        </motion.div>
      ))}
    </div>
  );
}

export function LobbyScreen({ nickname, count }: { nickname: string; count: number }) {
  return (
    <Centered>
      <Coins />
      <p className="text-sm uppercase tracking-[0.2em] text-gold">Tu es dans la partie</p>
      <h1 className="mt-3 max-w-full truncate text-4xl font-semibold tracking-tight">{nickname}</h1>
      <p className="mt-6 text-muted">En attente du lancement…</p>
      <p className="mt-10 text-sm text-subtle">
        <span className="tabular font-semibold text-fg">{count}</span> {count > 1 ? BRAND.audienceNoun.many : BRAND.audienceNoun.one} · {BRAND.anonymityNote}
      </p>
    </Centered>
  );
}

export function RemovedScreen() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">Tu as quitté la partie</h1>
      <p className="mt-2 text-muted">L’animatrice t’a retirée de cette partie.</p>
    </Centered>
  );
}

function QuestionHeader({ question, total, countdown }: { question: PublicQuestion; total?: number; countdown?: CountdownInfo }) {
  return (
    <div className="pt-5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-gold">
          Question {question.index + 1}
          {total ? ` sur ${total}` : ''}
          {question.allow_multiple && ' · plusieurs réponses'}
        </span>
        {countdown && (
          <span className={cn('tabular flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1 font-semibold', countdown.seconds <= 5 && !countdown.paused && 'text-[var(--color-opt-1)]')}>
            {countdown.paused ? <Pause className="size-3.5" /> : <Clock className="size-3.5" />}
            {countdown.paused ? 'Pause' : `${countdown.seconds}s`}
          </span>
        )}
      </div>
      {countdown && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-track">
          <div className="h-full rounded-full bg-gold transition-[width] duration-200 ease-linear" style={{ width: `${countdown.fraction * 100}%` }} />
        </div>
      )}
      <h1 className="mt-4 text-[1.55rem] font-semibold leading-tight tracking-tight">{question.text}</h1>
      {question.image_url && (
        <img src={question.image_url} alt="" className="mt-4 max-h-40 w-full rounded-2xl object-cover ring-1 ring-line" loading="eager" decoding="async" />
      )}
    </div>
  );
}

export function QuestionScreen({
  question,
  total,
  countdown,
  onSubmit,
  error,
}: {
  question: PublicQuestion;
  total: number;
  countdown: CountdownInfo;
  onSubmit: (ids: string[]) => void;
  error?: string;
  sending: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const multi = question.allow_multiple;
  const grid = question.options.length <= 4 && !multi;
  const disabled = countdown.paused;

  const tap = (id: string) => {
    if (disabled) return;
    if (multi) setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    else onSubmit([id]);
  };

  return (
    <div className="flex flex-1 flex-col">
      <QuestionHeader question={question} total={total} countdown={countdown} />
      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">
          {error} Touche une réponse pour réessayer.
        </p>
      )}
      <div className={cn('mt-5 flex-1', grid ? 'grid auto-rows-fr grid-cols-2 gap-3' : 'flex flex-col gap-2.5')}>
        {question.options.map((o, i) => {
          const isSel = selected.includes(o.id);
          return (
            <motion.button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => tap(o.id)}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: disabled ? 0.5 : 1, scale: 1 }}
              whileTap={{ scale: 0.95 }}
              transition={{ delay: i * 0.035, duration: 0.2 }}
              className={cn(
                'relative flex items-center rounded-2xl text-left font-semibold text-plum-deep shadow-[0_6px_0_0_rgba(0,0,0,0.25)] outline-none transition-[box-shadow,transform] active:translate-y-0.5 active:shadow-[0_2px_0_0_rgba(0,0,0,0.25)] focus-visible:ring-4 focus-visible:ring-fg/60',
                grid ? 'min-h-28 flex-col items-start justify-between p-4 text-[17px] leading-snug' : 'min-h-14 gap-3 px-4 py-3 text-base',
                multi && isSel && 'ring-4 ring-fg',
              )}
              style={{ background: optionColor(o.position) }}
              aria-pressed={multi ? isSel : undefined}
            >
              <span className={cn('flex shrink-0 items-center justify-center rounded-lg bg-plum-deep/15 text-sm font-bold', grid ? 'size-8' : 'size-7')}>
                {multi && isSel ? <Check className="size-4" /> : OPTION_LETTERS[o.position]}
              </span>
              <span className="break-words">{o.text}</span>
            </motion.button>
          );
        })}
      </div>
      {multi && (
        <div className="sticky bottom-0 mt-4 bg-gradient-to-t from-bg via-bg/95 to-transparent pb-1 pt-3">
          <Button size="lg" className="w-full" disabled={selected.length === 0 || disabled} onClick={() => onSubmit(selected)}>
            Valider{selected.length ? ` (${selected.length})` : ''}
          </Button>
        </div>
      )}
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="mt-8 flex items-center gap-2 text-muted">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-2 rounded-full bg-gold"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
        />
      ))}
      <span className="ml-1 text-sm">{label}</span>
    </div>
  );
}

export function AnsweredScreen({
  question,
  answer,
  paused,
  closed,
}: {
  question: PublicQuestion;
  answer: { optionIds: string[]; status: 'sending' | 'sent' | 'error' };
  paused?: boolean;
  closed?: boolean;
}) {
  const chosen = question.options.filter((o) => answer.optionIds.includes(o.id));
  const sent = answer.status === 'sent';
  return (
    <Centered>
      <motion.div
        initial={{ scale: 0.6 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
        className={cn('flex size-20 items-center justify-center rounded-full', sent ? 'bg-gold text-plum-deep' : 'bg-white/10 text-muted')}
      >
        {sent ? <Check className="size-10" strokeWidth={2.5} /> : <Hourglass className="size-9 animate-pulse" />}
      </motion.div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{sent ? 'Réponse envoyée !' : 'Envoi…'}</h1>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {chosen.map((o) => (
          <span key={o.id} className="rounded-full px-3 py-1.5 text-sm font-semibold text-plum-deep" style={{ background: optionColor(o.position) }}>
            {OPTION_LETTERS[o.position]} · {o.text}
          </span>
        ))}
      </div>
      <Waiting label={paused ? 'Question en pause…' : closed ? 'Résultats dans un instant…' : 'En attente des résultats…'} />
    </Centered>
  );
}

export function TimeUpScreen({ answered }: { answered: boolean }) {
  return (
    <Centered>
      <div className="flex size-20 items-center justify-center rounded-full bg-white/10">
        <Clock className="size-9 text-muted" />
      </div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Temps écoulé</h1>
      <p className="mt-2 text-muted">{answered ? 'Ta réponse a bien été prise en compte.' : 'Pas de réponse cette fois — prochaine question !'}</p>
      <Waiting label="Résultats dans un instant…" />
    </Centered>
  );
}

export function SpectatorScreen({ question }: { question: PublicQuestion }) {
  return (
    <div className="flex flex-1 flex-col">
      <QuestionHeader question={question} />
      <Centered className="flex-none py-10">
        <Sparkles className="size-8 text-gold" />
        <p className="mt-3 text-lg font-medium">Tu joues dès la prochaine question !</p>
        <p className="mt-1 text-sm text-muted">Cette question avait déjà commencé à ton arrivée.</p>
      </Centered>
    </div>
  );
}

export function RevealScreen({
  question,
  state,
  player,
  eligible,
  showScore,
}: {
  question: PublicQuestion;
  state: PublicState;
  player: PlayerState;
  eligible: boolean;
  showScore: boolean;
}) {
  const answer = player.answer && player.answer.question_index === question.index ? player.answer : null;
  const me = player.participant!;

  if (question.kind === 'poll') {
    const mine = new Set(answer?.selected_option_ids ?? []);
    return (
      <div className="flex flex-1 flex-col pt-5">
        <p className="text-sm text-gold">Question {question.index + 1} · résultats</p>
        <h1 className="mt-3 text-[1.45rem] font-semibold leading-tight">{question.text}</h1>
        <div className="mt-6">
          <OptionRows options={question.options} results={state.reveal} size="compact" />
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          {answer
            ? `Tu as répondu : ${question.options.filter((o) => mine.has(o.id)).map((o) => o.text).join(', ')}`
            : 'Tu n’as pas répondu à cette question.'}
        </p>
      </div>
    );
  }

  const correctIds = new Set(state.reveal?.correct_option_ids ?? []);
  const correctOption = question.options.find((o) => correctIds.has(o.id));
  const status: 'correct' | 'wrong' | 'none' | 'spectator' = !eligible ? 'spectator' : !answer ? 'none' : answer.is_correct ? 'correct' : 'wrong';

  return (
    <Centered>
      <motion.div
        initial={{ scale: 0.4, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 14 }}
        className={cn(
          'flex size-24 items-center justify-center rounded-full',
          status === 'correct' ? 'bg-success text-plum-deep' : 'bg-white/10 text-fg',
        )}
      >
        {status === 'correct' ? <Check className="size-12" strokeWidth={3} /> : status === 'wrong' ? <X className="size-11" /> : <Clock className="size-10" />}
      </motion.div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        {status === 'correct' ? 'Bonne réponse !' : status === 'wrong' ? 'Pas cette fois' : status === 'none' ? 'Pas de réponse' : 'Tu joues à la prochaine !'}
      </h1>
      {status === 'correct' && answer?.points != null && (
        <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="tabular mt-2 text-2xl font-semibold text-gold">
          +{answer.points} pts
        </motion.p>
      )}
      {status !== 'correct' && correctOption && (
        <p className="mt-3 text-muted">
          La bonne réponse : <span className="font-semibold text-fg">{correctOption.text}</span>
        </p>
      )}
      {status === 'wrong' && <p className="mt-1 text-sm text-subtle">On se rattrape à la prochaine 💪</p>}
      {state.reveal?.explanation && <p className="mt-5 max-w-sm rounded-2xl bg-card px-4 py-3 text-sm leading-relaxed text-muted ring-1 ring-line">{state.reveal.explanation}</p>}
      {showScore && (
        <div className="mt-8 grid w-full grid-cols-2 gap-3">
          <Stat label="Score total" value={me.total_score.toLocaleString('fr-FR')} />
          <Stat label="Classement" value={me.rank ? `${ordinal(me.rank)} / ${player.participants_count}` : '—'} />
        </div>
      )}
    </Centered>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-card px-4 py-3 ring-1 ring-line">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function LeaderboardScreen({ player, entries }: { player: PlayerState; entries: LeaderboardEntry[] }) {
  const me = player.participant!;
  const move = rankMovement(me.rank, me.previous_rank);
  return (
    <Centered>
      <p className="text-sm uppercase tracking-[0.2em] text-gold">Classement</p>
      <motion.p initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mt-3 font-serif text-7xl italic text-fg">
        {me.rank ? ordinal(me.rank) : '—'}
      </motion.p>
      <p className="mt-1 text-muted">sur {player.participants_count}</p>
      {move !== 0 && (
        <p className={cn('mt-4 flex items-center gap-1 font-medium', move > 0 ? 'text-success' : 'text-muted')}>
          {move > 0 ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
          {move > 0 ? `Tu gagnes ${move} place${move > 1 ? 's' : ''} !` : `Tu perds ${-move} place${-move > 1 ? 's' : ''}`}
        </p>
      )}
      <p className="tabular mt-6 text-3xl font-semibold">{me.total_score.toLocaleString('fr-FR')} pts</p>
      {entries[0] && me.rank !== 1 && (
        <p className="mt-6 text-sm text-subtle">
          En tête : {entries[0].nickname} · {entries[0].score.toLocaleString('fr-FR')} pts
        </p>
      )}
    </Centered>
  );
}

function endingMessage(rank: number | null, total: number) {
  if (!rank) return 'Merci d’avoir joué !';
  if (rank === 1) return 'Championne ! Tu as tout raflé 🏆';
  if (rank <= 3) return 'Sur le podium, bravo ! ✨';
  if (rank <= Math.ceil(total * 0.25)) return 'Dans le top 25 %, superbe partie !';
  if (rank <= Math.ceil(total / 2)) return 'Belle performance, continue comme ça !';
  return 'Merci d’avoir joué — chaque question, c’est une leçon en plus 💡';
}

export function FinalScreen({ player, state }: { player: PlayerState; state: PublicState }) {
  const me = player.participant!;
  const scored = Boolean(state.show_leaderboard);
  if (!scored) {
    return (
      <div className="flex flex-1 flex-col py-6">
        <Centered className="flex-none py-6">
          <Sparkles className="size-9 text-gold" />
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Merci, {me.nickname} !</h1>
          <p className="mt-2 text-muted">Voici le récap de la soirée.</p>
        </Centered>
        {state.recap && <RecapGrid recap={state.recap} size="compact" />}
      </div>
    );
  }
  const top = (state.leaderboard ?? []).slice(0, 3);
  const total = state.leaderboard?.length ?? player.participants_count ?? 0;
  return (
    <Centered>
      <Trophy className="size-10 text-gold" />
      <p className="mt-4 text-sm uppercase tracking-[0.2em] text-gold">Résultat final</p>
      <p className="mt-2 font-serif text-7xl italic">{me.rank ? ordinal(me.rank) : '—'}</p>
      <p className="tabular mt-2 text-2xl font-semibold">{me.total_score.toLocaleString('fr-FR')} pts</p>
      <p className="mt-3 max-w-xs text-muted">{endingMessage(me.rank, total)}</p>
      <ol className="mt-8 w-full space-y-2">
        {top.map((e) => (
          <li key={e.id} className={cn('flex items-center gap-3 rounded-2xl px-4 py-3 ring-1 ring-line', e.id === me.id ? 'bg-gold-soft ring-gold/50' : 'bg-card')}>
            <span className="font-serif text-2xl italic text-gold">{e.rank}</span>
            <span className="flex-1 truncate text-left font-medium">{e.nickname}</span>
            <span className="tabular font-semibold">{e.score.toLocaleString('fr-FR')}</span>
          </li>
        ))}
      </ol>
    </Centered>
  );
}
