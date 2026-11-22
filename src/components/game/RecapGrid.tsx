import { motion } from 'framer-motion';
import type { RecapQuestion } from '@/lib/types';
import { percent } from '@/lib/scoring';
import { cn } from '@/lib/utils';

/** Final summary of every played question: top answers with their share. */
export function RecapGrid({ recap, size = 'stage' }: { recap: RecapQuestion[]; size?: 'stage' | 'compact' }) {
  const stage = size === 'stage';
  const cols = recap.length > 9 ? 'grid-cols-4' : recap.length > 4 ? 'grid-cols-3' : 'grid-cols-2';
  return (
    <div className={cn('grid gap-[1.4vw]', stage ? cols : 'grid-cols-1 gap-3 sm:grid-cols-2')}>
      {recap.map((q, qi) => {
        const top = [...q.options].sort((a, b) => b.count - a.count || a.position - b.position).slice(0, 3);
        return (
          <motion.div
            key={q.index}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: qi * 0.05 }}
            className={cn('rounded-2xl bg-card ring-1 ring-line', stage ? 'p-[1.2vw]' : 'p-4')}
          >
            <p className={cn('text-gold', stage ? 'text-[clamp(0.7rem,0.85vw,1rem)]' : 'text-xs')}>
              Question {q.index + 1} · {q.total_answers} réponse{q.total_answers > 1 ? 's' : ''}
            </p>
            <p className={cn('mt-1 line-clamp-2 font-semibold leading-snug', stage ? 'text-[clamp(0.9rem,1.15vw,1.5rem)]' : 'text-base')}>{q.text}</p>
            <ul className={cn('mt-[0.8vw] space-y-[0.6vw]', !stage && 'mt-3 space-y-2')}>
              {top.map((o) => {
                const pct = percent(o.count, q.total_answers);
                return (
                  <li key={o.id}>
                    <div className={cn('flex justify-between gap-2', stage ? 'text-[clamp(0.75rem,0.95vw,1.2rem)]' : 'text-sm')}>
                      <span className={cn('truncate', o.is_correct ? 'text-gold' : 'text-fg/90')}>{o.text}</span>
                      <span className="tabular font-semibold">{pct}%</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-track">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: o.is_correct ? 'var(--color-gold)' : 'var(--color-fg)' }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.8, delay: 0.2 + qi * 0.05 }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        );
      })}
    </div>
  );
}
