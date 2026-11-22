import { Pause } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Circular countdown in the gold accent, as in the stage design. */
export function CountdownRing({
  seconds,
  fraction,
  paused,
  size = 120,
  className,
}: {
  seconds: number;
  fraction: number;
  paused?: boolean;
  size?: number;
  className?: string;
}) {
  const stroke = Math.max(3, size * 0.035);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const urgent = !paused && seconds <= 5 && seconds > 0;
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }} role="timer" aria-live="off" aria-label={paused ? 'En pause' : `${seconds} secondes`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={urgent ? 'var(--color-opt-1)' : 'var(--color-gold)'}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 0.25s linear, stroke 0.3s' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {paused ? (
          <Pause className="text-gold" style={{ width: size * 0.3, height: size * 0.3 }} />
        ) : (
          <span className={cn('tabular font-medium text-fg', urgent && 'text-[var(--color-opt-1)]')} style={{ fontSize: size * 0.32 }}>
            {seconds}
          </span>
        )}
      </div>
    </div>
  );
}
