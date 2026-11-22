import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Clock, X } from 'lucide-react';
import { OptionRows } from '@/components/game/OptionRows';
import { Button } from '@/components/ui/button';
import type { EditorQuiz } from '@/lib/quizDocument';
import type { PublicOption, QuestionResults } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Pre-flight check: every question as the room will see it, with the answer key. */
export function QuizPreview({ open, onOpenChange, quiz, startIndex }: { open: boolean; onOpenChange: (o: boolean) => void; quiz: EditorQuiz; startIndex: number }) {
  const [i, setI] = useState(startIndex);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (open) {
      setI(startIndex);
      setRevealed(false);
    }
  }, [open, startIndex]);
  useEffect(() => setRevealed(false), [i]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(quiz.questions.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      if (e.key === ' ') {
        e.preventDefault();
        setRevealed((r) => !r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, quiz.questions.length]);

  const q = quiz.questions[i];
  if (!q) return null;
  const options: PublicOption[] = q.options.map((o, k) => ({ id: o.key, position: k, text: o.text || `Réponse ${k + 1}` }));
  const results: QuestionResults | null = revealed
    ? {
        total_answers: 0,
        correct_count: 0,
        counts: {},
        correct_option_ids: q.kind === 'quiz' ? q.options.filter((o) => o.is_correct).map((o) => o.key) : [],
        explanation: q.explanation || null,
      }
    : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content className="glow-bg fixed left-1/2 top-1/2 z-50 flex aspect-video w-[min(94vw,160vh)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl p-[3%] ring-1 ring-line">
          <DialogPrimitive.Title className="sr-only">Aperçu du quiz</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Prévisualisation des questions telles qu’affichées à l’écran</DialogPrimitive.Description>
          <div className="flex items-center justify-between text-sm text-muted">
            <span className="flex items-center gap-3">
              <span className="text-gold">
                Question {i + 1} sur {quiz.questions.length}
                {q.allow_multiple && ' · plusieurs réponses'}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" /> {q.time_limit_sec} s
              </span>
              <span>{q.kind === 'quiz' ? 'Quiz noté' : 'Sondage'}</span>
            </span>
            <DialogPrimitive.Close className="rounded-full p-1.5 hover:bg-white/10" aria-label="Fermer l’aperçu">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="mt-[2%] grid min-h-0 flex-1 grid-cols-[1fr_auto] gap-[4%]">
            <div className="flex min-w-0 flex-col justify-center">
              <h2 className={cn('mb-[4%] font-semibold leading-tight tracking-tight', q.options.length > 5 ? 'text-[clamp(1.2rem,2.6vw,3rem)]' : 'text-[clamp(1.4rem,3vw,3.6rem)]')}>
                {q.question_text || <span className="italic text-subtle">Question sans titre</span>}
              </h2>
              <OptionRows options={options} results={results} dense={q.options.length > 5} />
              {revealed && q.explanation && <p className="mt-[3%] rounded-2xl bg-card p-3 text-sm text-cream/90 ring-1 ring-line">{q.explanation}</p>}
            </div>
            {q.image_url && (
              <div className="flex w-[22vw] max-w-xs items-center">
                <img src={q.image_url} alt="" className="max-h-[40vh] w-full rounded-2xl object-cover ring-1 ring-line" />
              </div>
            )}
          </div>
          <div className="mt-[2%] flex items-center justify-between">
            <Button variant="secondary" size="sm" onClick={() => setI((x) => Math.max(0, x - 1))} disabled={i === 0}>
              <ChevronLeft className="size-4" /> Précédente
            </Button>
            <Button size="sm" onClick={() => setRevealed((r) => !r)}>
              {revealed ? 'Masquer la réponse' : q.kind === 'quiz' ? 'Voir la bonne réponse' : 'Voir la révélation'} <kbd className="text-xs opacity-50">Espace</kbd>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setI((x) => Math.min(quiz.questions.length - 1, x + 1))} disabled={i === quiz.questions.length - 1}>
              Suivante <ChevronRight className="size-4" />
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
