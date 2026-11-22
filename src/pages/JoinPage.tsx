import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wordmark } from '@/components/brand/Wordmark';
import { JoinForm } from '@/components/play/JoinForm';

export default function JoinPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const pin = params.get('pin')?.replace(/\D/g, '').slice(0, 6);
  return (
    <main className="glow-bg flex min-h-dvh flex-col px-5 pb-10 pt-[max(env(safe-area-inset-top),1.5rem)]">
      <header className="mx-auto w-full max-w-sm">
        <Wordmark />
      </header>
      <div className="flex flex-1 items-center">
        <JoinForm pin={pin && pin.length === 6 ? pin : undefined} onJoined={(_, code) => navigate(`/play/${code}`, { replace: true })} />
      </div>
      <footer className="text-center text-xs text-subtle">
        <a href="/host" className="hover:text-muted">Espace animatrice</a>
      </footer>
    </main>
  );
}
