import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, RotateCcw } from 'lucide-react';
import { startSession } from '@/components/host/QuizGrid';
import { OptionRows } from '@/components/game/OptionRows';
import { Button } from '@/components/ui/button';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { resultsToCsv } from '@/lib/resultsExport';
import { percent } from '@/lib/scoring';
import { supabase } from '@/lib/supabase';
import type { GameSession, Participant, SessionQuestionPrivate } from '@/lib/types';
import { downloadFile, formatDateTime, slugify } from '@/lib/utils';

export default function SessionResultsPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<{ session: GameSession; participants: Participant[]; questions: SessionQuestionPrivate[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    void Promise.all([
      supabase.from('game_sessions').select('*').eq('id', sessionId).maybeSingle(),
      supabase.from('participants').select('*').eq('session_id', sessionId),
      supabase.from('session_questions').select('*').eq('session_id', sessionId).order('question_index'),
    ]).then(([s, p, q]) => {
      if (!s.data) return setError(true);
      setData({ session: s.data as GameSession, participants: (p.data as Participant[]) ?? [], questions: (q.data as SessionQuestionPrivate[]) ?? [] });
    });
  }, [sessionId]);

  if (error) return <p className="text-muted">Partie introuvable.</p>;
  if (!data) return <Spinner />;
  const { session, participants, questions } = data;
  const ranking = participants.filter((p) => !p.removed).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.joined_at.localeCompare(b.joined_at));
  const hasQuiz = questions.some((q) => q.kind === 'quiz');
  const played = questions.filter((q) => q.opened_at);

  const exportCsv = () =>
    downloadFile(
      `resultats-${slugify(session.quiz_title)}-${session.created_at.slice(0, 10)}.csv`,
      resultsToCsv({ quizTitle: session.quiz_title, date: formatDateTime(session.created_at), participants, questions: played }),
      'text/csv;charset=utf-8',
    );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="Retour">
          <Link to="/host/sessions"><ArrowLeft className="size-4" /></Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">{session.quiz_title}</h1>
          <p className="text-sm text-muted">
            {formatDateTime(session.created_at)} · {ranking.length} participante{ranking.length > 1 ? 's' : ''} · {played.length}/{session.question_count} questions jouées
          </p>
        </div>
        <Button variant="secondary" onClick={exportCsv} data-testid="export-csv">
          <Download className="size-4" /> Exporter CSV
        </Button>
        {session.quiz_id && (
          <Button onClick={() => void startSession(session.quiz_id!, navigate)}>
            <RotateCcw className="size-4" /> Rejouer (nouveau code)
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card className="h-fit p-0">
          <h2 className="border-b border-line px-5 py-4 font-semibold">{hasQuiz ? 'Classement final' : 'Participantes'}</h2>
          <ol className="max-h-[70vh] divide-y divide-line overflow-y-auto scrollbar-thin">
            {ranking.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                {hasQuiz && <span className="tabular w-6 font-semibold text-gold">{p.rank}</span>}
                <span className="min-w-0 flex-1 truncate">{p.nickname}</span>
                {hasQuiz && (
                  <>
                    <span className="text-xs text-muted">{p.correct_answers_count} ✓</span>
                    <span className="tabular w-14 text-right font-semibold">{p.total_score}</span>
                  </>
                )}
              </li>
            ))}
            {ranking.length === 0 && <li className="px-5 py-6 text-center text-sm text-subtle">Aucune participante.</li>}
          </ol>
        </Card>

        <div className="space-y-4">
          {played.map((q) => {
            const r = q.results;
            const total = r?.total_answers ?? 0;
            return (
              <Card key={q.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="text-gold">Question {q.question_index + 1}</Badge>
                  <Badge>{q.kind === 'quiz' ? 'Quiz' : q.allow_multiple ? 'Sondage multiple' : 'Sondage'}</Badge>
                  <Badge>{total} réponse{total > 1 ? 's' : ''}</Badge>
                  {q.kind === 'quiz' && <Badge className="text-success">{percent(r?.correct_count ?? 0, total)} % de bonnes réponses</Badge>}
                </div>
                <h3 className="mb-4 mt-3 text-lg font-semibold">{q.question_text}</h3>
                <OptionRows size="compact" options={q.options.map((o) => ({ id: o.id, position: o.position, text: o.text }))} results={r} />
              </Card>
            );
          })}
          {played.length === 0 && <p className="text-muted">Aucune question n’a été jouée.</p>}
        </div>
      </div>
    </div>
  );
}
