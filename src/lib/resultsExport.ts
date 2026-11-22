import Papa from 'papaparse';
import type { Participant, SessionQuestionPrivate } from './types';
import { percent } from './scoring';

export interface ResultsData {
  quizTitle: string;
  date: string;
  participants: Participant[];
  questions: SessionQuestionPrivate[];
}

/**
 * CSV with two sections: final ranking, then per-question results.
 * Poll answers stay anonymous (aggregates only) — matching the "c’est anonyme" promise.
 */
export function resultsToCsv(data: ResultsData): string {
  const ranking = [...data.participants]
    .filter((p) => !p.removed)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const hasQuiz = data.questions.some((q) => q.kind === 'quiz');

  const rankingCsv = Papa.unparse({
    fields: hasQuiz ? ['rang', 'prénom', 'score', 'bonnes réponses'] : ['prénom', 'arrivée'],
    data: ranking.map((p) =>
      hasQuiz
        ? [p.rank ?? '', p.nickname, p.total_score, p.correct_answers_count]
        : [p.nickname, new Date(p.joined_at).toLocaleTimeString('fr-FR')],
    ),
  });

  const questionRows: (string | number)[][] = [];
  for (const q of data.questions) {
    const r = q.results;
    const total = r?.total_answers ?? 0;
    for (const o of q.options) {
      const count = r?.counts?.[o.id] ?? 0;
      questionRows.push([
        q.question_index + 1,
        q.question_text,
        q.kind === 'quiz' ? 'quiz' : q.allow_multiple ? 'sondage (multiple)' : 'sondage',
        o.text,
        q.kind === 'quiz' ? (o.is_correct ? 'oui' : 'non') : '',
        count,
        `${percent(count, total)}%`,
        total,
        q.kind === 'quiz' ? `${percent(r?.correct_count ?? 0, total)}%` : '',
      ]);
    }
  }
  const questionsCsv = Papa.unparse({
    fields: ['n°', 'question', 'type', 'réponse', 'bonne réponse', 'votes', '% des répondantes', 'répondantes', '% de bonnes réponses'],
    data: questionRows,
  });

  return `﻿${data.quizTitle} — ${data.date}\n\nCLASSEMENT\n${rankingCsv}\n\nRÉSULTATS PAR QUESTION\n${questionsCsv}\n`;
}
