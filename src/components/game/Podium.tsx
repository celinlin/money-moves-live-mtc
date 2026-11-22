import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import confetti from 'canvas-confetti';
import { Crown } from 'lucide-react';
import type { LeaderboardEntry } from '@/lib/types';
import { cn } from '@/lib/utils';
import { play } from '@/lib/sound';

const COLORS = ['#d4a95a', '#e8e8b8', '#c9718a', '#f3dcdc'];

export function Podium({ entries, celebrate = true }: { entries: LeaderboardEntry[]; celebrate?: boolean }) {
  const reduce = useReducedMotion();
  const [first, second, third] = entries;

  useEffect(() => {
    if (!celebrate || !first) return;
    play('fanfare');
    if (reduce) return;
    const end = Date.now() + 2200;
    let raf = 0;
    const frame = () => {
      confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors: COLORS, disableForReducedMotion: true });
      confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors: COLORS, disableForReducedMotion: true });
      if (Date.now() < end) raf = requestAnimationFrame(frame);
    };
    const t = setTimeout(() => {
      confetti({ particleCount: 140, spread: 90, origin: { y: 0.45 }, colors: COLORS, disableForReducedMotion: true });
      frame();
    }, 1500);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [celebrate, first, reduce]);

  const slots: { e?: LeaderboardEntry; place: number; height: string; delay: number }[] = [
    { e: second, place: 2, height: '58%', delay: 0.6 },
    { e: first, place: 1, height: '80%', delay: 1.2 },
    { e: third, place: 3, height: '42%', delay: 0.2 },
  ];

  return (
    <div className="flex h-full w-full items-end justify-center gap-[2vw]">
      {slots.map(({ e, place, height, delay }) => (
        <div key={place} className="flex h-full w-[22vw] max-w-sm flex-col items-center justify-end">
          {e && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: delay + 0.35, duration: 0.45 }}
              className="mb-[2vh] flex w-full flex-col items-center text-center"
            >
              {place === 1 && <Crown className="mb-[1vh] size-[3.2vw] min-h-8 min-w-8 text-gold" />}
              <span className={cn('w-full truncate font-semibold', place === 1 ? 'text-[clamp(1.4rem,2.8vw,3.4rem)]' : 'text-[clamp(1.1rem,2vw,2.4rem)]')}>
                {e.nickname}
              </span>
              <span className="tabular text-[clamp(0.95rem,1.4vw,1.8rem)] text-muted">{e.score.toLocaleString('fr-FR')} pts</span>
            </motion.div>
          )}
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: e ? height : '12%' }}
            transition={{ delay, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'flex w-full items-start justify-center rounded-t-3xl pt-[2vh]',
              place === 1 ? 'bg-gold text-plum-deep' : 'bg-white/[0.08] text-fg ring-1 ring-line',
            )}
          >
            <span className="font-serif text-[clamp(2rem,5vw,6rem)] italic leading-none">{place}</span>
          </motion.div>
        </div>
      ))}
    </div>
  );
}
