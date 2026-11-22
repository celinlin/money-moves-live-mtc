import { useState } from 'react';
import { ArrowLeft, Pause, Play, Timer } from 'lucide-react';
import { ProgressDots } from '@/components/game/ProgressDots';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import type { useHostControls } from '@/hooks/useHostControls';
import { canPerform } from '@/lib/stateMachine';
import type { GameSession } from '@/lib/types';
import { cn } from '@/lib/utils';

type Controls = ReturnType<typeof useHostControls>;

export const TIMER_OPTIONS = [
  { value: 'auto', label: 'Par question' },
  ...[10, 15, 20, 30, 45, 60].map((s) => ({ value: String(s), label: `${s} s` })),
];

/** Presenter bar shown at the bottom of the stage (design: ← ⏸ [action · Espace] ••• ⏱ 30 s Terminer Réinitialiser). */
export function StageControlBar({ session, controls, className }: { session: GameSession; controls: Controls; className?: string }) {
  const { primary, runPrimary, run, pending, togglePause } = controls;
  const [confirm, setConfirm] = useState<null | 'finish' | 'reset'>(null);
  const stage = session.current_stage;
  const canPause = stage === 'QUESTION_OPEN' || stage === 'QUESTION_PAUSED';

  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="flex items-center gap-1 rounded-full bg-white/[0.05] p-1.5 ring-1 ring-line">
        <BarIcon label="Question précédente" disabled={!canPerform(session, 'previous') || Boolean(pending)} onClick={() => void run('previous')}>
          <ArrowLeft className="size-4" />
        </BarIcon>
        <BarIcon label={stage === 'QUESTION_PAUSED' ? 'Reprendre (P)' : 'Pause (P)'} disabled={!canPause || Boolean(pending)} onClick={togglePause}>
          {stage === 'QUESTION_PAUSED' ? <Play className="size-4" /> : <Pause className="size-4" />}
        </BarIcon>
        <button
          type="button"
          data-primary="true"
          onClick={runPrimary}
          disabled={!primary?.action || primary.disabled || Boolean(pending)}
          className="ml-1 flex h-10 items-center gap-3 rounded-full bg-fg pl-5 pr-4 text-[15px] font-medium text-plum-deep transition hover:bg-cream active:scale-[0.98] disabled:opacity-50"
        >
          {primary?.label}
          <kbd className="font-sans text-xs font-normal text-plum-deep/50">Espace</kbd>
        </button>
      </div>

      <ProgressDots count={session.question_count} current={session.current_question_index} className="hidden md:flex" />

      <div className="flex items-center gap-2 text-sm">
        <Timer className="size-4 text-muted" aria-hidden />
        <Select
          ariaLabel="Durée des questions"
          value={session.time_override_sec ? String(session.time_override_sec) : 'auto'}
          onValueChange={(v) => void run('set_timer', { seconds: v === 'auto' ? null : Number(v) }, { versioned: false })}
          options={TIMER_OPTIONS}
          className="h-9 bg-transparent px-3 ring-0 hover:bg-white/5"
        />
        {stage !== 'FINISHED' && stage !== 'LOBBY' && (
          <button type="button" className="rounded-full px-3 py-2 text-fg/90 hover:bg-white/5" onClick={() => setConfirm('finish')}>
            Terminer
          </button>
        )}
        <button type="button" className="rounded-full px-3 py-2 text-fg/90 hover:bg-white/5" onClick={() => setConfirm('reset')}>
          Réinitialiser
        </button>
      </div>

      <ConfirmDialog
        open={confirm === 'finish'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Terminer la partie ?"
        description="Les résultats de la question en cours sont comptés, puis le classement final s’affiche. Les participantes ne pourront plus répondre."
        confirmLabel="Terminer"
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
    </div>
  );
}

function BarIcon({ label, children, ...props }: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-10 items-center justify-center rounded-full text-fg/80 transition hover:bg-white/10 hover:text-fg disabled:opacity-30"
      {...props}
    >
      {children}
    </button>
  );
}
