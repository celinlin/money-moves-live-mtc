import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import type { PublicOption, QuestionResults } from '@/lib/types';
import { percent } from '@/lib/scoring';
import { cn, OPTION_LETTERS, optionColor } from '@/lib/utils';

/**
 * Answer rows with result bars (stage design). Before the reveal the bars stay
 * empty so the room is not influenced; on reveal they animate to their share.
 */
export function OptionRows({
  options,
  results,
  dense,
  size = 'stage',
}: {
  options: PublicOption[];
  results?: QuestionResults | null;
  dense?: boolean;
  size?: 'stage' | 'compact';
}) {
  const total = results?.total_answers ?? 0;
  const correct = new Set(results?.correct_option_ids ?? []);
  const isQuiz = correct.size > 0;
  const many = options.length > 5;
  const stage = size === 'stage';

  return (
    <ul className={cn('flex flex-col', stage ? (many || dense ? 'gap-[1.6vh]' : 'gap-[2.6vh]') : 'gap-3')}>
      {options.map((o, i) => {
        const count = results?.counts?.[o.id] ?? 0;
        const pct = percent(count, total);
        const isCorrect = correct.has(o.id);
        const dim = Boolean(results) && isQuiz && !isCorrect;
        return (
          <motion.li
            key={o.id}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: dim ? 0.42 : 1, x: 0 }}
            transition={{ delay: results ? 0 : 0.05 * i, duration: 0.3 }}
          >
            <div className={cn('flex items-baseline justify-between gap-4', stage ? 'mb-[0.9vh]' : 'mb-1.5')}>
              <span className={cn('flex min-w-0 items-center gap-[0.8em]', stage ? 'text-[clamp(1rem,1.55vw,2.1rem)]' : 'text-[15px]')}>
                <span
                  className="inline-flex size-[1.45em] shrink-0 items-center justify-center rounded-md text-[0.62em] font-semibold text-plum-deep"
                  style={{ background: optionColor(o.position) }}
                  aria-hidden
                >
                  {OPTION_LETTERS[o.position]}
                </span>
                <span className={cn('truncate', isCorrect && 'font-semibold text-gold')}>{o.text}</span>
                {isCorrect && <Check className="size-[1.1em] shrink-0 text-gold" aria-label="Bonne réponse" />}
              </span>
              {results && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.35 + i * 0.04 }}
                  className={cn('tabular shrink-0 font-semibold', stage ? 'text-[clamp(1rem,1.55vw,2.1rem)]' : 'text-[15px]', isCorrect && 'text-gold')}
                >
                  {pct}%
                </motion.span>
              )}
            </div>
            <div className={cn('overflow-hidden rounded-full bg-track', stage ? 'h-[0.9vh] min-h-1.5' : 'h-1.5')}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: isCorrect ? 'var(--color-gold)' : 'var(--color-fg)' }}
                initial={{ width: 0 }}
                animate={{ width: results ? `${pct}%` : 0 }}
                transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.1 + i * 0.05 }}
              />
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}
