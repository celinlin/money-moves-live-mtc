import { describe, expect, it } from 'vitest';
import {
  documentToEditor,
  editorToDocument,
  emptyQuestion,
  emptyQuiz,
  estimateDurationSec,
  parseQuizCsv,
  parseQuizJson,
  quizToCsv,
  validateEditorQuiz,
} from '@/lib/quizDocument';

describe('editor validation', () => {
  it('flags empty fields with question numbers', () => {
    const issues = validateEditorQuiz(emptyQuiz());
    expect(issues.some((i) => i.questionIndex === 0 && /texte/.test(i.message))).toBe(true);
    expect(issues.some((i) => /réponse vide/.test(i.message))).toBe(true);
  });
  it('requires exactly one correct answer for quiz questions only', () => {
    const quiz = emptyQuiz();
    const q = quiz.questions[0];
    q.question_text = 'Q';
    q.options = q.options.map((o, i) => ({ ...o, text: `o${i}`, is_correct: false }));
    expect(validateEditorQuiz(quiz).map((i) => i.message).join()).toMatch(/exactement une bonne réponse/);
    q.kind = 'poll';
    expect(validateEditorQuiz(quiz)).toEqual([]);
  });
  it('enforces 2–8 options and timer bounds', () => {
    const quiz = emptyQuiz();
    const q = emptyQuestion('poll');
    q.question_text = 'Q';
    q.options = [{ key: 'x', text: 'only', is_correct: false }];
    q.time_limit_sec = 3;
    quiz.questions = [q];
    const msgs = validateEditorQuiz(quiz).map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/au moins 2/);
    expect(msgs).toMatch(/minuteur trop court/);
  });
  it('round-trips through the document format', () => {
    const quiz = emptyQuiz();
    quiz.questions[0].question_text = ' Hello ';
    quiz.questions[0].options = quiz.questions[0].options.map((o, i) => ({ ...o, text: `o${i}` }));
    const doc = editorToDocument(quiz);
    expect(doc.questions[0].question_text).toBe('Hello');
    expect(doc.questions[0].image_url).toBeNull();
    const back = documentToEditor(doc);
    expect(editorToDocument(back)).toEqual(doc);
  });
});

describe('JSON import', () => {
  it('accepts a full document', () => {
    const res = parseQuizJson(JSON.stringify({
      title: 'Imported',
      questions: [{ question_text: 'A?', options: [{ text: 'x', is_correct: true }, { text: 'y' }] }],
    }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.document.questions[0].kind).toBe('quiz');
      expect(res.document.questions[0].time_limit_sec).toBe(20);
    }
  });
  it('accepts a bare array of questions', () => {
    const res = parseQuizJson(JSON.stringify([{ kind: 'poll', question_text: 'P?', options: [{ text: 'a' }, { text: 'b' }] }]), 'Fallback');
    expect(res.ok && res.document.title).toBe('Fallback');
  });
  it('reports precise errors', () => {
    const bad = parseQuizJson('{"title":"x","questions":[{"question_text":"","options":[{"text":"a"}]}]}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.message).join()).toMatch(/Question 1/);
    const broken = parseQuizJson('{oops');
    expect(!broken.ok && broken.issues[0].message).toMatch(/JSON illisible/);
  });
});

describe('CSV import/export', () => {
  const csv = `question;type;multiple;time_limit;answer_1;answer_2;answer_3;correct;explanation
Que signifie ETF ?;quiz;;15;Exchange Traded Fund;Euro Tax Fund;;1;Fonds coté
Tu as ouvert quoi ?;sondage;oui;30;PEA;Livret A;Crypto;;`;
  it('parses semicolon CSV with quiz and multi-choice poll rows', () => {
    const res = parseQuizCsv(csv, 'CSV');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [q1, q2] = res.document.questions;
    expect(q1).toMatchObject({ kind: 'quiz', time_limit_sec: 15, explanation: 'Fonds coté' });
    expect(q1.options.map((o) => o.is_correct)).toEqual([true, false]);
    expect(q2).toMatchObject({ kind: 'poll', allow_multiple: true });
    expect(q2.options).toHaveLength(3);
  });
  it('rejects an invalid correct column with the CSV line number', () => {
    const res = parseQuizCsv('question,answer_1,answer_2,correct\nQ?,a,b,5');
    expect(!res.ok && res.issues[0].message).toMatch(/Ligne 2/);
  });
  it('rejects files without the required headers', () => {
    const res = parseQuizCsv('foo,bar\n1,2');
    expect(!res.ok && res.issues[0].message).toMatch(/En-têtes manquants/);
  });
  it('exports CSV that re-imports identically', () => {
    const res = parseQuizCsv(csv, 'CSV');
    if (!res.ok) throw new Error('parse failed');
    const again = parseQuizCsv(quizToCsv(res.document), 'CSV');
    expect(again.ok && again.document.questions).toEqual(res.document.questions);
  });
});

it('estimates duration with reveal overhead', () => {
  expect(estimateDurationSec([{ time_limit_sec: 20 }, { time_limit_sec: 30 }])).toBe(90);
});
