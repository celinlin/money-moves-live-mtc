import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  Copy,
  Download,
  Eye,
  FileUp,
  GripVertical,
  ImagePlus,
  Play,
  Plus,
  Save,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { startSession } from '@/components/host/QuizGrid';
import { QuizPreview } from '@/components/host/QuizPreview';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { FullPageSpinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { friendlyError } from '@/lib/errors';
import {
  documentToEditor,
  editorToDocument,
  emptyQuestion,
  emptyQuiz,
  estimateDurationSec,
  MAX_OPTIONS,
  MIN_OPTIONS,
  newKey,
  parseQuizCsv,
  parseQuizJson,
  questionToEditor,
  quizToCsv,
  TIMER_PRESETS,
  validateEditorQuiz,
  type EditorQuestion,
  type EditorQuiz,
  type QuizDocument,
  type ValidationIssue,
} from '@/lib/quizDocument';
import { rpc, supabase } from '@/lib/supabase';
import { cn, downloadFile, formatDuration, OPTION_LETTERS, optionColor, slugify } from '@/lib/utils';

export default function QuizEditorPage() {
  const { quizId = 'new' } = useParams();
  const navigate = useNavigate();
  const isNew = quizId === 'new';
  const [quiz, setQuiz] = useState<EditorQuiz | null>(isNew ? emptyQuiz() : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pendingImport, setPendingImport] = useState<QuizDocument | null>(null);
  const [importIssues, setImportIssues] = useState<ValidationIssue[] | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) return;
    rpc<QuizDocument>('get_quiz_document', { p_quiz_id: quizId })
      .then((doc) => {
        const q = documentToEditor(doc);
        setQuiz(q);
        setSelected(q.questions[0]?.key ?? null);
        setDirty(false);
      })
      .catch((err) => {
        toast.error(friendlyError(err));
        navigate('/host/quizzes', { replace: true });
      });
  }, [quizId, isNew, navigate]);

  useEffect(() => {
    if (quiz && !selected && quiz.questions[0]) setSelected(quiz.questions[0].key);
  }, [quiz, selected]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  const update = useCallback((fn: (q: EditorQuiz) => EditorQuiz) => {
    setQuiz((q) => (q ? fn(q) : q));
    setDirty(true);
  }, []);

  const updateQuestion = useCallback(
    (key: string, patch: Partial<EditorQuestion> | ((q: EditorQuestion) => EditorQuestion)) =>
      update((qz) => ({
        ...qz,
        questions: qz.questions.map((q) => (q.key === key ? (typeof patch === 'function' ? patch(q) : { ...q, ...patch }) : q)),
      })),
    [update],
  );

  const issues = useMemo(() => (quiz ? validateEditorQuiz(quiz) : []), [quiz]);
  const issueByQuestion = useMemo(() => new Set(issues.map((i) => i.questionIndex).filter((i): i is number => i != null)), [issues]);

  const save = useCallback(async (): Promise<string | null> => {
    if (!quiz) return null;
    if (issues.length) {
      setShowIssues(true);
      toast.error(`${issues.length} point${issues.length > 1 ? 's' : ''} à corriger avant d’enregistrer`);
      return null;
    }
    setSaving(true);
    try {
      const id = await rpc<string>('save_quiz', { p_quiz_id: isNew ? null : quizId, p_quiz: editorToDocument(quiz) });
      setDirty(false);
      toast.success('Quiz enregistré');
      if (isNew) navigate(`/host/quizzes/${id}/edit`, { replace: true });
      return id;
    } catch (err) {
      toast.error(friendlyError(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [quiz, issues, isNew, quizId, navigate]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    update((qz) => {
      const from = qz.questions.findIndex((q) => q.key === e.active.id);
      const to = qz.questions.findIndex((q) => q.key === e.over!.id);
      return { ...qz, questions: arrayMove(qz.questions, from, to) };
    });
  };

  const addQuestion = (kind: 'quiz' | 'poll') => {
    const q = emptyQuestion(kind);
    update((qz) => {
      const idx = qz.questions.findIndex((x) => x.key === selected);
      const questions = [...qz.questions];
      questions.splice(idx >= 0 ? idx + 1 : questions.length, 0, q);
      return { ...qz, questions };
    });
    setSelected(q.key);
  };

  const duplicateQuestion = (key: string) => {
    let copyKey = '';
    update((qz) => {
      const idx = qz.questions.findIndex((x) => x.key === key);
      const src = qz.questions[idx];
      const copy = { ...src, key: newKey(), options: src.options.map((o) => ({ ...o, key: newKey() })) };
      copyKey = copy.key;
      const questions = [...qz.questions];
      questions.splice(idx + 1, 0, copy);
      return { ...qz, questions };
    });
    setSelected(copyKey);
  };

  const deleteQuestion = (key: string) => {
    if (!quiz) return;
    const idx = quiz.questions.findIndex((x) => x.key === key);
    const next = quiz.questions[idx + 1] ?? quiz.questions[idx - 1];
    update((qz) => ({ ...qz, questions: qz.questions.filter((q) => q.key !== key) }));
    setSelected(next?.key ?? null);
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const res = /\.csv$/i.test(file.name) ? parseQuizCsv(text, quiz?.title) : parseQuizJson(text, quiz?.title);
    if (!res.ok) setImportIssues(res.issues);
    else setPendingImport(res.document);
  };

  const applyImport = (mode: 'append' | 'replace') => {
    if (!pendingImport) return;
    const imported = pendingImport.questions.map(questionToEditor);
    update((qz) => ({ ...qz, questions: mode === 'replace' ? imported : [...qz.questions, ...imported] }));
    setSelected(imported[0]?.key ?? null);
    setPendingImport(null);
    toast.success(`${imported.length} question${imported.length > 1 ? 's' : ''} importée${imported.length > 1 ? 's' : ''} — pense à enregistrer`);
  };

  if (!quiz) return <FullPageSpinner />;
  const current = quiz.questions.find((q) => q.key === selected) ?? null;
  const currentIndex = current ? quiz.questions.indexOf(current) : -1;

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Retour" onClick={() => (dirty ? setLeaveConfirm(true) : navigate('/host/quizzes'))}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">
            {quiz.questions.length} question{quiz.questions.length > 1 ? 's' : ''} · {formatDuration(estimateDurationSec(quiz.questions))}
            {dirty ? <span className="text-gold"> · modifications non enregistrées</span> : ' · enregistré'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          <FileUp className="size-4" /> Importer
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onImportFile(f);
          }}
        />
        <ExportMenu quiz={quiz} />
        <Button variant="secondary" size="sm" onClick={() => setPreview(true)} disabled={quiz.questions.length === 0}>
          <Eye className="size-4" /> Aperçu
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty && !isNew}>
          <Save className="size-4" /> Enregistrer
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            const id = dirty || isNew ? await save() : quizId;
            if (id) await startSession(id, navigate);
          }}
        >
          <Play className="size-4" /> Lancer
        </Button>
      </div>

      {/* Quiz settings */}
      <div className="grid gap-4 rounded-2xl bg-card p-5 ring-1 ring-line md:grid-cols-[1fr_1fr_auto]">
        <div>
          <Label htmlFor="title">Titre</Label>
          <Input id="title" value={quiz.title} maxLength={120} onChange={(e) => update((q) => ({ ...q, title: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="desc">Description</Label>
          <Input id="desc" value={quiz.description} maxLength={500} placeholder="Optionnelle" onChange={(e) => update((q) => ({ ...q, description: e.target.value }))} />
        </div>
        <label className="flex items-center gap-3 self-end rounded-xl px-1 py-2.5 text-sm">
          <Switch checked={quiz.show_leaderboard} onCheckedChange={(v) => update((q) => ({ ...q, show_leaderboard: v }))} />
          <span>
            Points & classement
            <span className="block text-xs text-muted">Pour les questions « quiz »</span>
          </span>
        </label>
      </div>

      {showIssues && issues.length > 0 && (
        <div className="rounded-2xl bg-danger/10 p-4 text-sm text-danger ring-1 ring-danger/30" role="alert">
          <p className="mb-2 flex items-center gap-2 font-medium">
            <AlertCircle className="size-4" /> À corriger avant d’enregistrer
          </p>
          <ul className="space-y-1">
            {issues.slice(0, 8).map((i, k) => (
              <li key={k}>
                <button type="button" className="text-left hover:underline" onClick={() => i.questionIndex != null && setSelected(quiz.questions[i.questionIndex]?.key ?? null)}>
                  • {i.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Question list */}
        <aside className="space-y-3">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={quiz.questions.map((q) => q.key)} strategy={verticalListSortingStrategy}>
              <ol className="space-y-2">
                {quiz.questions.map((q, i) => (
                  <SortableQuestion
                    key={q.key}
                    question={q}
                    index={i}
                    active={q.key === selected}
                    invalid={showIssues && issueByQuestion.has(i)}
                    onSelect={() => setSelected(q.key)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" onClick={() => addQuestion('quiz')}>
              <Plus className="size-4" /> Quiz
            </Button>
            <Button variant="secondary" size="sm" onClick={() => addQuestion('poll')}>
              <Plus className="size-4" /> Sondage
            </Button>
          </div>
        </aside>

        {/* Question editor */}
        {current ? (
          <QuestionEditor
            key={current.key}
            question={current}
            index={currentIndex}
            onChange={(patch) => updateQuestion(current.key, patch)}
            onDuplicate={() => duplicateQuestion(current.key)}
            onDelete={() => deleteQuestion(current.key)}
          />
        ) : (
          <div className="flex items-center justify-center rounded-2xl border border-dashed border-line p-12 text-muted">Ajoute une question pour commencer.</div>
        )}
      </div>

      <QuizPreview open={preview} onOpenChange={setPreview} quiz={quiz} startIndex={Math.max(0, currentIndex)} />

      <Dialog open={Boolean(pendingImport)} onOpenChange={(o) => !o && setPendingImport(null)}>
        <DialogContent
          title="Importer des questions"
          description={`${pendingImport?.questions.length ?? 0} question(s) valides trouvées. Que veux-tu en faire ?`}
        >
          <div className="flex flex-col gap-2">
            <Button onClick={() => applyImport('append')}>Ajouter à la fin du quiz</Button>
            <Button variant="danger" onClick={() => applyImport('replace')}>
              Remplacer les {quiz.questions.length} question(s) existantes
            </Button>
            <p className="mt-1 text-xs text-muted">Rien n’est enregistré tant que tu ne cliques pas sur « Enregistrer ».</p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(importIssues)} onOpenChange={(o) => !o && setImportIssues(null)}>
        <DialogContent title="Import impossible" description="Corrige ces points dans ton fichier :">
          <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm text-danger scrollbar-thin">
            {importIssues?.slice(0, 30).map((i, k) => <li key={k}>• {i.message}</li>)}
          </ul>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={leaveConfirm}
        onOpenChange={setLeaveConfirm}
        title="Quitter sans enregistrer ?"
        description="Tes dernières modifications seront perdues."
        confirmLabel="Quitter"
        danger
        onConfirm={() => {
          setDirty(false);
          navigate('/host/quizzes');
        }}
      />
    </div>
  );
}

function SortableQuestion({
  question,
  index,
  active,
  invalid,
  onSelect,
}: {
  question: EditorQuestion;
  index: number;
  active: boolean;
  invalid: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: question.key });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-xl p-2 pr-3 ring-1 transition',
        active ? 'bg-white/10 ring-gold/50' : 'bg-card ring-line hover:bg-white/[0.07]',
        isDragging && 'z-10 shadow-2xl',
        invalid && 'ring-danger/60',
      )}
    >
      <button type="button" className="cursor-grab touch-none rounded p-1 text-subtle hover:text-fg active:cursor-grabbing" aria-label={`Déplacer la question ${index + 1}`} {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="tabular w-5 shrink-0 text-xs text-muted">{index + 1}</span>
        {question.kind === 'quiz' ? <Trophy className="size-3.5 shrink-0 text-gold" aria-label="Quiz" /> : <BarChart3 className="size-3.5 shrink-0 text-blush" aria-label="Sondage" />}
        <span className={cn('truncate text-sm', !question.question_text && 'italic text-subtle')}>{question.question_text || 'Question sans titre'}</span>
        <span className="ml-auto shrink-0 text-xs text-subtle">{question.time_limit_sec}s</span>
        {invalid && <AlertCircle className="size-4 shrink-0 text-danger" aria-label="À corriger" />}
      </button>
    </li>
  );
}

function QuestionEditor({
  question,
  index,
  onChange,
  onDuplicate,
  onDelete,
}: {
  question: EditorQuestion;
  index: number;
  onChange: (patch: Partial<EditorQuestion> | ((q: EditorQuestion) => EditorQuestion)) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const isQuiz = question.kind === 'quiz';
  const custom = !TIMER_PRESETS.includes(question.time_limit_sec as (typeof TIMER_PRESETS)[number]);

  const setKind = (kind: 'quiz' | 'poll') =>
    onChange((q) => {
      if (q.kind === kind) return q;
      const hasCorrect = q.options.some((o) => o.is_correct);
      return {
        ...q,
        kind,
        allow_multiple: kind === 'quiz' ? false : q.allow_multiple,
        options: kind === 'quiz' && !hasCorrect ? q.options.map((o, i) => ({ ...o, is_correct: i === 0 })) : q.options,
      };
    });

  return (
    <section className="space-y-6 rounded-2xl bg-card p-6 ring-1 ring-line" aria-label={`Question ${index + 1}`}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Question {index + 1}</h2>
        <div className="flex rounded-full bg-white/[0.06] p-1 ring-1 ring-line" role="radiogroup" aria-label="Type de question">
          {(['quiz', 'poll'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={question.kind === k}
              onClick={() => setKind(k)}
              className={cn('flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition', question.kind === k ? 'bg-fg text-plum-deep' : 'text-muted hover:text-fg')}
            >
              {k === 'quiz' ? <Trophy className="size-3.5" /> : <BarChart3 className="size-3.5" />}
              {k === 'quiz' ? 'Quiz noté' : 'Sondage'}
            </button>
          ))}
        </div>
        {!isQuiz && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={question.allow_multiple} onCheckedChange={(v) => onChange({ allow_multiple: v })} />
            Plusieurs réponses possibles
          </label>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" aria-label="Dupliquer la question" onClick={onDuplicate}>
            <Copy className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Supprimer la question" onClick={onDelete} className="hover:text-danger">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div>
        <Label htmlFor="qtext">Question</Label>
        <Textarea
          id="qtext"
          value={question.question_text}
          maxLength={300}
          rows={2}
          placeholder="Ex. As-tu déjà investi ?"
          className="text-lg"
          onChange={(e) => onChange({ question_text: e.target.value })}
          autoFocus={!question.question_text}
        />
        <p className="mt-1 text-right text-xs text-subtle">{question.question_text.length}/300</p>
      </div>

      <div>
        <Label>Minuteur</Label>
        <div className="flex flex-wrap items-center gap-2">
          {TIMER_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ time_limit_sec: s })}
              className={cn('rounded-full px-3.5 py-1.5 text-sm ring-1 transition', question.time_limit_sec === s ? 'bg-fg text-plum-deep ring-fg' : 'ring-line hover:bg-white/10')}
            >
              {s} s
            </button>
          ))}
          <label className={cn('flex items-center gap-2 rounded-full px-3 py-1 text-sm ring-1', custom ? 'ring-gold/60' : 'ring-line')}>
            Autre
            <input
              type="number"
              min={5}
              max={300}
              value={question.time_limit_sec}
              onChange={(e) => onChange({ time_limit_sec: Math.max(5, Math.min(300, Number(e.target.value) || 5)) })}
              className="w-14 bg-transparent text-right outline-none"
              aria-label="Durée personnalisée en secondes"
            />
            s
          </label>
        </div>
      </div>

      <div>
        <Label>
          Réponses {isQuiz ? '— coche la bonne réponse' : question.allow_multiple ? '— plusieurs choix possibles' : '— un seul choix'}
        </Label>
        <ul className="space-y-2">
          {question.options.map((o, i) => (
            <li key={o.key} className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-plum-deep" style={{ background: optionColor(i) }}>
                {OPTION_LETTERS[i]}
              </span>
              <Input
                value={o.text}
                maxLength={120}
                placeholder={`Réponse ${i + 1}`}
                aria-label={`Réponse ${OPTION_LETTERS[i]}`}
                onChange={(e) => onChange((q) => ({ ...q, options: q.options.map((x) => (x.key === o.key ? { ...x, text: e.target.value } : x)) }))}
              />
              {isQuiz && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={o.is_correct}
                  aria-label={`Marquer ${OPTION_LETTERS[i]} comme bonne réponse`}
                  onClick={() => onChange((q) => ({ ...q, options: q.options.map((x) => ({ ...x, is_correct: x.key === o.key })) }))}
                  className={cn('h-11 shrink-0 rounded-xl px-3 text-sm ring-1 transition', o.is_correct ? 'bg-success/20 text-success ring-success/50' : 'text-muted ring-line hover:bg-white/10')}
                >
                  {o.is_correct ? '✓ Bonne' : 'Bonne ?'}
                </button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Supprimer la réponse ${OPTION_LETTERS[i]}`}
                disabled={question.options.length <= MIN_OPTIONS}
                onClick={() =>
                  onChange((q) => {
                    const options = q.options.filter((x) => x.key !== o.key);
                    if (q.kind === 'quiz' && o.is_correct && options[0]) options[0] = { ...options[0], is_correct: true };
                    return { ...q, options };
                  })
                }
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        {question.options.length < MAX_OPTIONS && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => onChange((q) => ({ ...q, options: [...q.options, { key: newKey(), text: '', is_correct: false }] }))}
          >
            <Plus className="size-4" /> Ajouter une réponse
          </Button>
        )}
      </div>

      <ImageField value={question.image_url} onChange={(url) => onChange({ image_url: url })} />

      <div>
        <Label htmlFor="expl">Explication après la révélation (optionnelle)</Label>
        <Textarea
          id="expl"
          rows={2}
          maxLength={600}
          value={question.explanation}
          placeholder="Ex. Règle de 72 : 72 ÷ 7 ≈ 10 ans."
          onChange={(e) => onChange({ explanation: e.target.value })}
        />
      </div>
    </section>
  );
}

function ImageField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) return toast.error('Image trop lourde (5 Mo max).');
    setUploading(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `${u.user!.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('quiz-images').upload(path, file, { cacheControl: '31536000', contentType: file.type });
      if (error) throw error;
      onChange(supabase.storage.from('quiz-images').getPublicUrl(path).data.publicUrl);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setUploading(false);
    }
  };
  return (
    <div>
      <Label htmlFor="img">Image (optionnelle)</Label>
      <div className="flex gap-2">
        <Input id="img" value={value} placeholder="https://… ou importe un fichier" onChange={(e) => onChange(e.target.value)} />
        <Button variant="secondary" onClick={() => ref.current?.click()} loading={uploading}>
          <ImagePlus className="size-4" /> Importer
        </Button>
        <input
          ref={ref}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>
      {value && (
        <div className="relative mt-3 inline-block">
          <img src={value} alt="Aperçu" className="max-h-40 rounded-xl ring-1 ring-line" onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.3')} />
          <button type="button" className="absolute right-2 top-2 rounded-full bg-black/60 p-1" aria-label="Retirer l’image" onClick={() => onChange('')}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function ExportMenu({ quiz }: { quiz: EditorQuiz }) {
  const [open, setOpen] = useState(false);
  const doc = () => editorToDocument(quiz);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Download className="size-4" /> Exporter
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Exporter le quiz" description="Le fichier contient les questions et réponses, réimportables à tout moment.">
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => {
                downloadFile(`${slugify(quiz.title)}.json`, JSON.stringify(doc(), null, 2), 'application/json');
                setOpen(false);
              }}
            >
              JSON (recommandé)
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                downloadFile(`${slugify(quiz.title)}.csv`, `﻿${quizToCsv(doc())}`, 'text/csv;charset=utf-8');
                setOpen(false);
              }}
            >
              CSV (tableur)
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { Link };
