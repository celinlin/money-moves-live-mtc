import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { FullPageSpinner } from '@/components/ui/misc';
import { useAuth } from '@/hooks/useAuth';
import { rpc, supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type Access = 'checking' | 'granted' | 'denied';

/** Server-side allow-list check: being signed in is not enough to be a presenter. */
function useHostAccess(userId: string | undefined) {
  const [access, setAccess] = useState<Access>('checking');
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setAccess('checking');
    (async () => {
      try {
        const status = await rpc<{ is_host: boolean; can_claim: boolean }>('host_status');
        let ok = status.is_host;
        // The very first presenter claims the platform; afterwards access is by invitation only.
        if (!ok && status.can_claim) ok = await rpc<boolean>('claim_first_host');
        if (alive) setAccess(ok ? 'granted' : 'denied');
      } catch {
        if (alive) setAccess('denied');
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);
  return access;
}

export default function HostLayout() {
  const { isHost, loading, user } = useAuth();
  const access = useHostAccess(isHost ? user?.id : undefined);
  if (loading) return <FullPageSpinner />;
  if (!isHost) return <HostLogin />;
  if (access === 'checking') return <FullPageSpinner />;
  if (access === 'denied') return <AccessDenied email={user?.email} />;
  return (
    <div className="glow-bg min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
          <NavLink to="/host">
            <Wordmark className="text-lg" />
          </NavLink>
          <nav className="flex gap-1 text-sm">
            {[
              ['/host', 'Tableau de bord'],
              ['/host/quizzes', 'Quiz'],
              ['/host/sessions', 'Historique'],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) => cn('rounded-full px-3 py-1.5 transition', isActive ? 'bg-white/10 text-fg' : 'text-muted hover:text-fg')}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span className="hidden truncate sm:inline">{user?.email}</span>
            <Button variant="ghost" size="icon" aria-label="Se déconnecter" onClick={() => void supabase.auth.signOut()}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function AccessDenied({ email }: { email?: string }) {
  return (
    <main className="glow-bg flex min-h-dvh flex-col items-center justify-center px-5 text-center">
      <div className="w-full max-w-sm rounded-3xl bg-card p-8 ring-1 ring-line">
        <Wordmark />
        <h1 className="mt-6 text-2xl font-semibold">Accès réservé</h1>
        <p className="mt-2 text-sm text-muted">
          Le compte {email ? <b className="text-fg">{email}</b> : 'connecté'} n’est pas autorisé à animer des parties. Demande à
          l’administratrice de la plateforme de t’ajouter.
        </p>
        <Button className="mt-6 w-full" variant="secondary" onClick={() => void supabase.auth.signOut()}>
          Se déconnecter
        </Button>
      </div>
    </main>
  );
}

function HostLogin() {
  const [signupOpen, setSignupOpen] = useState(false);
  useEffect(() => {
    // Account creation is only offered while the platform has no presenter yet.
    supabase.rpc('host_signup_open').then(({ data }) => setSignupOpen(data === true));
  }, []);
  const allowSignup = import.meta.env.VITE_ALLOW_HOST_SIGNUP !== 'false' && signupOpen;
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);
    // A participant identity may exist in this browser: replace it with the host account.
    const { data: current } = await supabase.auth.getSession();
    if (current.session?.user.is_anonymous) await supabase.auth.signOut();
    const res =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/host` } });
    setLoading(false);
    if (res.error) {
      setError(res.error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.' : res.error.message);
    } else if (mode === 'signup' && !res.data.session) {
      setInfo('Compte créé. Confirme ton adresse via l’email reçu, puis connecte-toi.');
      setMode('signin');
    }
  };

  return (
    <main className="glow-bg flex min-h-dvh flex-col items-center justify-center px-5">
      <form onSubmit={submit} className="w-full max-w-sm rounded-3xl bg-card p-8 ring-1 ring-line">
        <Wordmark />
        <h1 className="mt-6 text-2xl font-semibold">Espace animatrice</h1>
        <p className="mt-1 text-sm text-muted">Crée tes quiz et pilote tes parties en direct.</p>
        <div className="mt-6 space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        {info && <p role="status" className="mt-4 text-sm text-success">{info}</p>}
        <Button type="submit" className="mt-6 w-full" size="lg" loading={loading}>
          {mode === 'signin' ? 'Se connecter' : 'Créer mon compte'}
        </Button>
        {allowSignup && (
          <button type="button" className="mt-4 w-full text-center text-sm text-muted hover:text-fg" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
          </button>
        )}
      </form>
    </main>
  );
}
