import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Download, FileUp, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog';
import { Badge, Spinner } from '@/components/ui/misc';
import { friendlyError } from '@/lib/errors';
import { estimateDurationSec, parseQuizCsv, parseQuizJson, type ValidationIssue } from '@/lib/quizDocument';
import { rpc, supabase } from '@/lib/supabase';
import type { QuizRow } from '@/lib/types';
import { downloadFile, formatDate, formatDuration, slugify } from '@/lib/utils';

type QuizWithQuestions = QuizRow & { questions: { time_limit_sec: number }[] };

export function useQuizzes() {
  const [quizzes, setQuizzes] = useState<QuizWithQuestions[] | null>(null);
  const load = useCallback(async () => {
    await rpc('ensure_sample_quizzes').catch(() => undefined);
    const { data, error } = await supabase.from('quizzes').select('*, questions(time_limit_sec)').order('updated_at', { ascending: false });
    if (error) toast.error(friendlyError(error));
    setQuizzes((data as QuizWithQuestions[]) ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { quizzes, reload: load };
}

export async function startSession(quizId: string, navigate: (to: string) => void) {
  try {
    const s = await rpc<{ id: string }>('create_session', { p_quiz_id: quizId });
    navigate(`/host/session/${s.id}`);
  } catch (err) {
    toast.error(friendlyError(err));
  }
}

export function QuizGrid({ showImport = true }: { showImport?: boolean }) {
  const { quizzes, reload } = useQuizzes();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<QuizRow | null>(null);
  const [importIssues, setImportIssues] = useState<ValidationIssue[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (file: File) => {
    const text = await file.text();
    const title = file.name.replace(/\.(json|csv)$/i, '');
    const res = /\.csv$/i.test(file.name) ? parseQuizCsv(text, title) : parseQuizJson(text, title);
    if (!res.ok) return setImportIssues(res.issues);
    try {
      const id = await rpc<string>('save_quiz', { p_quiz_id: null, p_quiz: res.document });
      toast.success(`Quiz importé : ${res.document.questions.length} questions`);
      navigate(`/host/quizzes/${id}/edit`);
    } catch (err) {
      toast.error(friendlyError(err));
    }
  };

  const exportQuiz = async (q: QuizRow) => {
    try {
      const doc = await rpc<object>('get_quiz_document', { p_quiz_id: q.id });
      downloadFile(`${slugify(q.title)}.json`, JSON.stringify(doc, null, 2), 'application/json');
    } catch (err) {
      toast.error(friendlyError(err));
    }
  };

  if (!quizzes) return <Spinner />;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link to="/host/quizzes/new/edit">
            <Plus className="size-4" /> Nouveau quiz
          </Link>
        </Button>
        {showImport && (
          <>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <FileUp className="size-4" /> Importer (JSON / CSV)
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv,application/json,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onImport(f);
              }}
            />
            <a href="/templates/quiz-template.csv" download className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
              Modèle CSV
            </a>
          </>
        )}
      </div>

      {quizzes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">Aucun quiz pour l’instant. Crée ton premier quiz !</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quizzes.map((q) => (
            <article key={q.id} className="group flex flex-col rounded-2xl bg-card p-5 ring-1 ring-line transition hover:ring-white/20" data-testid="quiz-card">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-lg font-semibold leading-snug">{q.title}</h3>
                <QuizMenu
                  onDuplicate={async () => {
                    try {
                      await rpc('duplicate_quiz', { p_quiz_id: q.id });
                      toast.success('Quiz dupliqué');
                      void reload();
                    } catch (err) {
                      toast.error(friendlyError(err));
                    }
                  }}
                  onExport={() => void exportQuiz(q)}
                  onDelete={() => setToDelete(q)}
                />
              </div>
              {q.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{q.description}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {q.is_sample && <Badge className="text-gold">Exemple</Badge>}
                <Badge>{q.questions.length} question{q.questions.length > 1 ? 's' : ''}</Badge>
                <Badge>{formatDuration(estimateDurationSec(q.questions))}</Badge>
                {!q.show_leaderboard && <Badge>Anonyme</Badge>}
              </div>
              <p className="mt-3 text-xs text-subtle">Modifié le {formatDate(q.updated_at)}</p>
              <div className="mt-5 flex gap-2 pt-1">
                <Button
                  className="flex-1"
                  loading={starting === q.id}
                  disabled={q.questions.length === 0}
                  onClick={async () => {
                    setStarting(q.id);
                    await startSession(q.id, navigate);
                    setStarting(null);
                  }}
                >
                  <Play className="size-4" /> Lancer
                </Button>
                <Button variant="secondary" asChild>
                  <Link to={`/host/quizzes/${q.id}/edit`}>
                    <Pencil className="size-4" /> Modifier
                  </Link>
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Supprimer ce quiz ?"
        description={`« ${toDelete?.title} » sera supprimé définitivement. Les résultats des parties déjà jouées sont conservés.`}
        confirmLabel="Supprimer"
        danger
        onConfirm={async () => {
          if (!toDelete) return;
          const { error } = await supabase.from('quizzes').delete().eq('id', toDelete.id);
          if (error) toast.error(friendlyError(error));
          else toast.success('Quiz supprimé');
          void reload();
        }}
      />
      <Dialog open={Boolean(importIssues)} onOpenChange={(o) => !o && setImportIssues(null)}>
        <DialogContent title="Import impossible" description="Corrige ces points dans ton fichier puis réessaie :">
          <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm text-danger scrollbar-thin">
            {importIssues?.slice(0, 30).map((i, k) => <li key={k}>• {i.message}</li>)}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QuizMenu({ onDuplicate, onExport, onDelete }: { onDuplicate: () => void; onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10';
  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Plus d’actions" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-xl bg-bg-raised p-1 shadow-2xl ring-1 ring-line">
          <button className={item} onClick={() => { setOpen(false); onDuplicate(); }}><Copy className="size-4" /> Dupliquer</button>
          <button className={item} onClick={() => { setOpen(false); onExport(); }}><Download className="size-4" /> Exporter JSON</button>
          <button className={`${item} text-danger`} onClick={() => { setOpen(false); onDelete(); }}><Trash2 className="size-4" /> Supprimer</button>
        </div>
      )}
    </div>
  );
}
