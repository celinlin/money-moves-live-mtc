import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { LeaderboardEntry } from '@/lib/types';
import { rankMovement } from '@/lib/scoring';
import { cn } from '@/lib/utils';

/**
 * Animated ranking: rows first appear in their previous order, then glide to
 * their new positions, so the room sees who overtook whom.
 */
export function LeaderboardList({
  entries,
  limit = 5,
  highlightId,
  size = 'stage',
}: {
  entries: LeaderboardEntry[];
  limit?: number;
  highlightId?: string;
  size?: 'stage' | 'compact';
}) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [entries]);

  const top = entries.slice(0, limit);
  const ordered = settled
    ? top
    : [...top].sort((a, b) => (a.previous_rank ?? a.rank) - (b.previous_rank ?? b.rank));
  const stage = size === 'stage';

  return (
    <ol className={cn('flex flex-col', stage ? 'gap-[1.6vh]' : 'gap-2')}>
      <AnimatePresence initial={false}>
        {ordered.map((e, i) => {
          const move = rankMovement(e.rank, e.previous_rank);
          return (
            <motion.li
              layout
              key={e.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ layout: { type: 'spring', stiffness: 260, damping: 30 }, delay: settled ? 0 : i * 0.06 }}
              className={cn(
                'flex items-center gap-4 rounded-2xl ring-1 ring-line',
                stage ? 'px-[2vw] py-[1.8vh]' : 'px-4 py-3',
                e.id === highlightId ? 'bg-gold-soft ring-gold/50' : 'bg-card',
                settled && e.rank === 1 && 'bg-gold-soft',
              )}
            >
              <span className={cn('tabular w-[2ch] text-right font-semibold text-gold', stage ? 'text-[clamp(1.2rem,2vw,2.6rem)]' : 'text-lg')}>
                {settled ? e.rank : (e.previous_rank ?? e.rank)}
              </span>
              <span className={cn('min-w-0 flex-1 truncate font-medium', stage ? 'text-[clamp(1.1rem,1.9vw,2.4rem)]' : 'text-base')}>{e.nickname}</span>
              {settled && move !== 0 && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={cn('flex items-center gap-0.5 font-medium', move > 0 ? 'text-success' : 'text-muted', stage ? 'text-[clamp(0.9rem,1.2vw,1.5rem)]' : 'text-xs')}
                >
                  {move > 0 ? <ArrowUp className="size-[1em]" /> : <ArrowDown className="size-[1em]" />}
                  {Math.abs(move)}
                </motion.span>
              )}
              <span className={cn('tabular font-semibold', stage ? 'text-[clamp(1.1rem,1.9vw,2.4rem)]' : 'text-base')}>
                {e.score.toLocaleString('fr-FR')}
              </span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
