import { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { friendlyError } from '@/lib/errors';
import { ensureSession, rpc } from '@/lib/supabase';
import { cn } from '@/lib/utils';

export interface JoinResult {
  session_id: string;
  participant_id: string;
  nickname: string;
  rejoined: boolean;
}

/**
 * "Rejoindre — Entre ton prénom pour participer." When the PIN comes from the
 * QR code / link it is already known, so only the first name is asked.
 */
export function JoinForm({ pin, onJoined }: { pin?: string; onJoined: (res: JoinResult, pin: string) => void }) {
  const [code, setCode] = useState(pin ?? '');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cleanCode = code.replace(/\D/g, '').slice(0, 6);
  const canSubmit = cleanCode.length === 6 && nickname.trim().length > 0 && !loading;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await ensureSession();
      const res = await rpc<JoinResult>('join_session', { p_pin: cleanCode, p_nickname: nickname.trim() });
      try {
        localStorage.setItem(`mml-session:${cleanCode}`, res.session_id);
      } catch {
        /* private mode */
      }
      onJoined(res, cleanCode);
    } catch (err) {
      setError(friendlyError(err));
      setLoading(false);
    }
  };

  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto flex w-full max-w-sm flex-col items-center"
      noValidate
    >
      <h1 className="text-[2.6rem] font-semibold tracking-tight">Rejoindre</h1>
      <p className="mt-2 text-center text-[15px] text-muted">
        {pin ? 'Entre ton prénom pour participer.' : 'Entre le code affiché à l’écran et ton prénom.'}
      </p>
      <div className="mt-8 flex w-full flex-col gap-3">
        {!pin && (
          <input
            aria-label="Code de la partie"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Code (6 chiffres)"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="h-16 w-full rounded-full bg-white/[0.05] text-center text-2xl tracking-[0.3em] text-fg outline-none ring-1 ring-transparent transition placeholder:tracking-normal placeholder:text-subtle/70 focus:ring-gold/60"
            autoFocus
          />
        )}
        <input
          aria-label="Ton prénom"
          autoComplete="given-name"
          autoCapitalize="words"
          enterKeyHint="go"
          maxLength={24}
          placeholder="Ton prénom"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="h-16 w-full rounded-full bg-white/[0.05] px-6 text-center text-2xl text-fg outline-none ring-1 ring-transparent transition placeholder:text-subtle/70 focus:ring-gold/60"
          autoFocus={Boolean(pin)}
        />
        <Button type="submit" size="lg" className={cn('mt-1 h-14 w-full text-base', !canSubmit && 'opacity-35')} disabled={!canSubmit} loading={loading}>
          Continuer
        </Button>
        {error && (
          <p role="alert" className="mt-1 text-center text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </motion.form>
  );
}
