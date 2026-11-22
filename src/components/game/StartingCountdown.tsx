import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export function StartingCountdown({ seconds, className }: { seconds: number; className?: string }) {
  const value = Math.max(1, Math.min(3, seconds));
  return (
    <div className={cn('flex flex-col items-center justify-center', className)} aria-live="assertive">
      <p className="mb-[3vh] text-[clamp(1rem,1.6vw,2rem)] text-muted">Prête ?</p>
      <div className="relative flex size-[min(40vw,40vh)] items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full ring-2 ring-gold/40"
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ repeat: Infinity, duration: 1 }}
        />
        <AnimatePresence mode="popLayout">
          <motion.span
            key={value}
            initial={{ scale: 1.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="font-serif text-[min(24vw,24vh)] italic leading-none text-gold"
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
