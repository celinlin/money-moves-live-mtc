import { cn } from '@/lib/utils';

export function ProgressDots({ count, current, className }: { count: number; current: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <div className={cn('flex items-center gap-1.5', className)} aria-label={`Question ${current + 1} sur ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            i === current ? 'w-7 bg-fg' : i < current ? 'w-1.5 bg-fg/60' : 'w-1.5 bg-white/15',
          )}
        />
      ))}
    </div>
  );
}
