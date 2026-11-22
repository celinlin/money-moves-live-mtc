// Quiz documents: the JSON format used by the editor, import/export and the
// save_quiz RPC. Validation here mirrors the server's (which stays authoritative)
// so presenters get precise, friendly errors before saving.
import Papa from 'papaparse';
import { z } from 'zod';

export const TIMER_PRESETS = [10, 15, 20, 30, 45, 60] as const;
export const MAX_OPTIONS = 8;
export const MIN_OPTIONS = 2;

export interface EditorOption {
  key: string;
  text: string;
  is_correct: boolean;
}

export interface EditorQuestion {
  key: string;
  kind: 'quiz' | 'poll';
  allow_multiple: boolean;
  question_text: string;
  image_url: string;
  time_limit_sec: number;
  explanation: string;
  options: EditorOption[];
}

export interface EditorQuiz {
  title: string;
  description: string;
  show_leaderboard: boolean;
  questions: EditorQuestion[];
}

const optionSchema = z.object({
  text: z.string().trim().min(1, 'réponse vide').max(120, 'réponse trop longue (120 caractères max)'),
  is_correct: z.boolean().optional().default(false),
});

const questionSchema = z
  .object({
    kind: z.enum(['quiz', 'poll']).optional().default('quiz'),
    allow_multiple: z.boolean().optional().default(false),
    question_text: z.string().trim().min(1, 'texte de la question manquant').max(300, 'question trop longue (300 caractères max)'),
    image_url: z.string().trim().max(2000).nullable().optional(),
    time_limit_sec: z.number().int().min(5, 'minuteur trop court (5 s min)').max(300, 'minuteur trop long (300 s max)').optional().default(20),
    explanation: z.string().max(600, 'explication trop longue (600 caractères max)').nullable().optional(),
    options: z.array(optionSchema).min(MIN_OPTIONS, `au moins ${MIN_OPTIONS} réponses`).max(MAX_OPTIONS, `${MAX_OPTIONS} réponses maximum`),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.is_correct).length;
    if (q.kind === 'quiz' && correct !== 1) {
      ctx.addIssue({ code: 'custom', message: 'une question de quiz doit avoir exactement une bonne réponse', path: ['options'] });
    }
  });

export const quizDocumentSchema = z.object({
  title: z.string().trim().min(1, 'titre manquant').max(120),
  description: z.string().max(500).optional().default(''),
  show_leaderboard: z.boolean().optional().default(true),
  questions: z.array(questionSchema).max(100, '100 questions maximum'),
});

export type QuizDocument = z.infer<typeof quizDocumentSchema>;
export type QuestionDocument = z.infer<typeof questionSchema>;

let keySeq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(keySeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyQuestion(kind: 'quiz' | 'poll' = 'quiz'): EditorQuestion {
  return {
    key: newKey(),
    kind,
    allow_multiple: false,
    question_text: '',
    image_url: '',
    time_limit_sec: kind === 'poll' ? 30 : 20,
    explanation: '',
    options: [
      { key: newKey(), text: '', is_correct: kind === 'quiz' },
      { key: newKey(), text: '', is_correct: false },
      { key: newKey(), text: '', is_correct: false },
      { key: newKey(), text: '', is_correct: false },
    ],
  };
}

export function emptyQuiz(): EditorQuiz {
  return { title: 'Nouveau quiz', description: '', show_leaderboard: true, questions: [emptyQuestion()] };
}

export function documentToEditor(doc: QuizDocument | QuestionDocument[] | Record<string, any>): EditorQuiz {
  const d = doc as QuizDocument;
  return {
    title: d.title ?? '',
    description: d.description ?? '',
    show_leaderboard: d.show_leaderboard ?? true,
    questions: (d.questions ?? []).map(questionToEditor),
  };
}

export function questionToEditor(q: Partial<QuestionDocument>): EditorQuestion {
  return {
    key: newKey(),
    kind: (q.kind as 'quiz' | 'poll') ?? 'quiz',
    allow_multiple: Boolean(q.allow_multiple),
    question_text: q.question_text ?? '',
    image_url: q.image_url ?? '',
    time_limit_sec: q.time_limit_sec ?? 20,
    explanation: q.explanation ?? '',
    options: (q.options ?? []).map((o) => ({ key: newKey(), text: o.text ?? '', is_correct: Boolean(o.is_correct) })),
  };
}

export function editorToDocument(quiz: EditorQuiz): QuizDocument {
  return {
    title: quiz.title.trim(),
    description: quiz.description.trim(),
    show_leaderboard: quiz.show_leaderboard,
    questions: quiz.questions.map((q) => ({
      kind: q.kind,
      allow_multiple: q.kind === 'poll' && q.allow_multiple,
      question_text: q.question_text.trim(),
      image_url: q.image_url.trim() || null,
      time_limit_sec: q.time_limit_sec,
      explanation: q.explanation.trim() || null,
      options: q.options.map((o) => ({ text: o.text.trim(), is_correct: q.kind === 'quiz' && o.is_correct })),
    })),
  };
}

export interface ValidationIssue {
  questionIndex: number | null;
  message: string;
}

function issuesFromZod(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => {
    const qi = issue.path[0] === 'questions' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
    const oi = issue.path[2] === 'options' && typeof issue.path[3] === 'number' ? issue.path[3] : null;
    const where = qi != null ? `Question ${qi + 1}${oi != null ? `, réponse ${oi + 1}` : ''} : ` : '';
    return { questionIndex: qi, message: `${where}${issue.message}` };
  });
}

export function validateEditorQuiz(quiz: EditorQuiz): ValidationIssue[] {
  const parsed = quizDocumentSchema.safeParse(editorToDocument(quiz));
  const issues = parsed.success ? [] : issuesFromZod(parsed.error);
  if (quiz.questions.length === 0) issues.push({ questionIndex: null, message: 'Ajoute au moins une question.' });
  return issues;
}

export type ImportResult =
  | { ok: true; document: QuizDocument }
  | { ok: false; issues: ValidationIssue[] };

/** Accepts a full quiz document, or a bare array of questions. */
export function parseQuizJson(text: string, fallbackTitle = 'Quiz importé'): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ questionIndex: null, message: `JSON illisible : ${(e as Error).message}` }] };
  }
  const candidate = Array.isArray(raw) ? { title: fallbackTitle, questions: raw } : raw;
  const parsed = quizDocumentSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  if (parsed.data.questions.length === 0) return { ok: false, issues: [{ questionIndex: null, message: 'Aucune question trouvée.' }] };
  return { ok: true, document: parsed.data };
}

export const CSV_HEADERS = [
  'question', 'type', 'multiple', 'time_limit',
  'answer_1', 'answer_2', 'answer_3', 'answer_4', 'answer_5', 'answer_6', 'answer_7', 'answer_8',
  'correct', 'explanation', 'image_url',
] as const;

const truthy = (v: string | undefined) => /^(1|true|oui|yes|x|vrai)$/i.test((v ?? '').trim());

/**
 * CSV format (header row required; separator , or ; auto-detected):
 * question,type,multiple,time_limit,answer_1..answer_8,correct,explanation,image_url
 * - type: quiz | poll (also accepts "sondage"); default quiz
 * - correct: 1-based number of the right answer (quiz only)
 */
export function parseQuizCsv(text: string, title = 'Quiz importé'): ImportResult {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (res.errors.length) {
    return { ok: false, issues: res.errors.slice(0, 5).map((e) => ({ questionIndex: e.row ?? null, message: `CSV ligne ${(e.row ?? 0) + 2} : ${e.message}` })) };
  }
  const fields = res.meta.fields ?? [];
  if (!fields.includes('question') || !fields.includes('answer_1')) {
    return { ok: false, issues: [{ questionIndex: null, message: 'En-têtes manquants : il faut au moins les colonnes « question », « answer_1 » et « answer_2 ».' }] };
  }
  const issues: ValidationIssue[] = [];
  const questions = res.data.map((row, i) => {
    const typeRaw = (row.type ?? '').trim().toLowerCase();
    const kind: 'quiz' | 'poll' = typeRaw === 'poll' || typeRaw === 'sondage' ? 'poll' : 'quiz';
    const answers = Array.from({ length: MAX_OPTIONS }, (_, k) => (row[`answer_${k + 1}`] ?? '').trim()).filter(Boolean);
    const correctIdx = parseInt((row.correct ?? '').trim(), 10) - 1;
    if (kind === 'quiz' && (Number.isNaN(correctIdx) || correctIdx < 0 || correctIdx >= answers.length)) {
      issues.push({ questionIndex: i, message: `Ligne ${i + 2} : colonne « correct » invalide (numéro de la bonne réponse, entre 1 et ${answers.length}).` });
    }
    const limit = parseInt((row.time_limit ?? '').trim(), 10);
    return {
      kind,
      allow_multiple: kind === 'poll' && truthy(row.multiple),
      question_text: (row.question ?? '').trim(),
      image_url: (row.image_url ?? '').trim() || null,
      time_limit_sec: Number.isNaN(limit) ? 20 : limit,
      explanation: (row.explanation ?? '').trim() || null,
      options: answers.map((text, k) => ({ text, is_correct: kind === 'quiz' && k === correctIdx })),
    };
  });
  if (issues.length) return { ok: false, issues };
  const parsed = quizDocumentSchema.safeParse({ title, questions });
  if (!parsed.success) {
    return {
      ok: false,
      issues: issuesFromZod(parsed.error).map((iss) => ({
        ...iss,
        message: iss.message.replace(/^Question (\d+)/, (_, n) => `Ligne ${Number(n) + 1}`),
      })),
    };
  }
  if (parsed.data.questions.length === 0) return { ok: false, issues: [{ questionIndex: null, message: 'Aucune question trouvée.' }] };
  return { ok: true, document: parsed.data };
}

export function quizToCsv(doc: QuizDocument): string {
  const rows = doc.questions.map((q) => {
    const row: Record<string, string | number> = {
      question: q.question_text,
      type: q.kind,
      multiple: q.allow_multiple ? 'true' : '',
      time_limit: q.time_limit_sec,
      correct: q.kind === 'quiz' ? q.options.findIndex((o) => o.is_correct) + 1 : '',
      explanation: q.explanation ?? '',
      image_url: q.image_url ?? '',
    };
    q.options.forEach((o, k) => (row[`answer_${k + 1}`] = o.text));
    return row;
  });
  return Papa.unparse({ fields: [...CSV_HEADERS], data: rows.map((r) => CSV_HEADERS.map((h) => r[h] ?? '')) });
}

export function estimateDurationSec(questions: { time_limit_sec: number }[]) {
  // Time limit + ~20 s per question for the reveal and commentary.
  return questions.reduce((acc, q) => acc + q.time_limit_sec + 20, 0);
}
