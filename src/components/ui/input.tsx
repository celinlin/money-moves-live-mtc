import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-xl bg-white/[0.06] px-4 text-[15px] text-fg ring-1 ring-line outline-none transition placeholder:text-subtle focus:bg-white/[0.08] focus:ring-2 focus:ring-gold/70 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full resize-y rounded-xl bg-white/[0.06] px-4 py-3 text-[15px] text-fg ring-1 ring-line outline-none transition placeholder:text-subtle focus:bg-white/[0.08] focus:ring-2 focus:ring-gold/70',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted', className)} {...props} />;
}
