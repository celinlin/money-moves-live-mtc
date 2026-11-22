import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Radio } from 'lucide-react';
import { QuizGrid } from '@/components/host/QuizGrid';
import { Button } from '@/components/ui/button';
import { STAGE_LABELS } from '@/lib/stateMachine';
import { supabase } from '@/lib/supabase';
import type { GameSession } from '@/lib/types';
import { formatDateTime, formatPin } from '@/lib/utils';

export default function HostDashboard() {
  const [active, setActive] = useState<GameSession[]>([]);
  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) =>
      supabase
        .from('game_sessions')
        .select('*')
        .eq('status', 'active')
        .eq('host_id', data.user?.id ?? '')
        .order('created_at', { ascending: false })
        .limit(5)
        .then(({ data: rows }) => setActive((rows as GameSession[]) ?? [])),
    );
  }, []);

  return (
    <div className="space-y-10">
      {active.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-gold">
            <Radio className="size-4" /> Parties en cours
          </h2>
          <div className="space-y-2">
            {active.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 rounded-2xl bg-gold-soft px-5 py-4 ring-1 ring-gold/30">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{s.quiz_title}</p>
                  <p className="text-sm text-muted">
                    Code {formatPin(s.game_pin)} · {STAGE_LABELS[s.current_stage]} · créée le {formatDateTime(s.created_at)}
                  </p>
                </div>
                <Button asChild>
                  <Link to={`/host/session/${s.id}`}>
                    Reprendre <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h1 className="mb-6 text-3xl font-semibold tracking-tight">Mes quiz</h1>
        <QuizGrid />
      </section>
    </div>
  );
}
