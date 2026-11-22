import { Link } from 'react-router-dom';
import { Wordmark } from '@/components/brand/Wordmark';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <main className="glow-bg flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <Wordmark />
      <h1 className="text-3xl font-semibold">Page introuvable</h1>
      <Button asChild>
        <Link to="/">Rejoindre une partie</Link>
      </Button>
    </main>
  );
}
