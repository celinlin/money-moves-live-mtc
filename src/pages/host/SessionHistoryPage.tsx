import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarChart3, Play, RotateCcw } from 'lucide-react';
import { startSession } from '@/components/host/QuizGrid';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/misc';
import { STAGE_LABELS } from '@/lib/stateMachine';
import { supabase } from '@/lib/supabase';
import type { GameSession } from '@/lib/types';
import { formatDateTime, formatPin } from '@/lib/utils';

type Row = GameSession & { session_live: { participants_count: number } | null };

export default function SessionHistoryPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    void supabase.auth.getUser().then(({ data: u }) =>
      supabase
        .from('game_sessions')
        .select('id, quiz_id, quiz_title, game_pin, status, current_stage, question_count, created_at, finished_at, session_live(participants_count)')
        .eq('host_id', u.user?.id ?? '')
        .order('created_at', { ascending: false })
        .limit(100)
        .then(({ data }) => setRows((data as unknown as Row[]) ?? [])),
    );
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Historique des parties</h1>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">Aucune partie jouée pour l’instant.</div>
      ) : (
        <div className="overflow-hidden rounded-2xl ring-1 ring-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.04] text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Quiz</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Participantes</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Statut</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDateTime(s.created_at)}</td>
                  <td className="px-4 py-3 font-medium">{s.quiz_title}</td>
                  <td className="hidden px-4 py-3 tabular sm:table-cell">{s.session_live?.participants_count ?? 0}</td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {s.status === 'finished' ? <Badge>Terminée</Badge> : <Badge className="text-gold">{STAGE_LABELS[s.current_stage]} · {formatPin(s.game_pin)}</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {s.status === 'active' ? (
                        <Button size="sm" asChild>
                          <Link to={`/host/session/${s.id}`}><Play className="size-4" /> Reprendre</Link>
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" asChild>
                          <Link to={`/host/sessions/${s.id}/results`}><BarChart3 className="size-4" /> Résultats</Link>
                        </Button>
                      )}
                      {s.quiz_id && (
                        <Button size="sm" variant="ghost" title="Rejouer avec un nouveau code" onClick={() => void startSession(s.quiz_id!, navigate)}>
                          <RotateCcw className="size-4" /> Rejouer
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
