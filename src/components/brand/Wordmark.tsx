import { BRAND } from '@/config/brand';
import { cn } from '@/lib/utils';

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-serif text-[1.35rem] tracking-tight text-cream/90', className)}>
      {BRAND.wordmark.main} <em className="font-serif italic">{BRAND.wordmark.accent}</em>
    </span>
  );
}
