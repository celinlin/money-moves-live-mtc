import { WifiOff } from 'lucide-react';
import type { ConnectionState } from '@/hooks/useGameSession';
import { cn } from '@/lib/utils';

/** Only visible when something is wrong — no noise when the connection is healthy. */
export function ConnectionBanner({ state, className }: { state: ConnectionState; className?: string }) {
  if (state === 'live' || state === 'connecting') return null;
  return (
    <div className={cn('flex items-center justify-center gap-2 bg-danger/15 px-4 py-2 text-sm text-danger', className)} role="status">
      <WifiOff className="size-4" />
      {state === 'offline' ? 'Hors ligne — reconnexion automatique dès le retour du réseau…' : 'Connexion instable — on se resynchronise…'}
    </div>
  );
}
