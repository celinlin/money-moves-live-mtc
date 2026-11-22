// Presenter-side view of the game state machine. The server validates every
// transition; this module only decides what to *offer*, so the presenter always
// sees one dominant next action.
import type { GameSession, GameStage, SessionLive } from './types';

export type HostAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'close'
  | 'reveal'
  | 'leaderboard'
  | 'next'
  | 'previous'
  | 'finish'
  | 'final_view'
  | 'set_timer'
  | 'set_auto_close'
  | 'remove_participant'
  | 'reset';

export interface PrimaryAction {
  action: HostAction | null;
  label: string;
  args?: Record<string, unknown>;
  disabled?: boolean;
}

/** Valid transitions, mirroring host_action() in the database. */
export const TRANSITIONS: Record<GameStage, HostAction[]> = {
  LOBBY: ['start'],
  STARTING: [],
  QUESTION_OPEN: ['pause', 'close', 'reveal', 'previous'],
  QUESTION_PAUSED: ['resume', 'close', 'reveal', 'previous'],
  QUESTION_CLOSED: ['reveal', 'previous'],
  ANSWER_REVEAL: ['leaderboard', 'next', 'previous'],
  LEADERBOARD: ['next', 'previous'],
  FINISHED: ['final_view'],
};

const ALWAYS: HostAction[] = ['set_timer', 'set_auto_close', 'remove_participant', 'reset'];

export function canPerform(session: Pick<GameSession, 'current_stage' | 'current_question_index' | 'question_count'>, action: HostAction) {
  if (ALWAYS.includes(action)) return true;
  if (action === 'finish') return session.current_stage !== 'FINISHED';
  if (!TRANSITIONS[session.current_stage].includes(action)) return false;
  if (action === 'previous') return session.current_question_index > 0;
  if (action === 'next') return session.current_question_index + 1 < session.question_count;
  if (action === 'leaderboard') return true;
  return true;
}

export function isLastQuestion(session: Pick<GameSession, 'current_question_index' | 'question_count'>) {
  return session.current_question_index >= session.question_count - 1;
}

/** Does the current question use the leaderboard flow (scored quiz + leaderboard enabled)? */
export function usesLeaderboard(session: Pick<GameSession, 'public_state'>) {
  return Boolean(session.public_state.show_leaderboard && session.public_state.question?.kind === 'quiz');
}

export function hasLeaderboard(session: Pick<GameSession, 'public_state'>) {
  return Boolean(session.public_state.show_leaderboard);
}

export function getPrimaryAction(session: GameSession, _live?: Pick<SessionLive, "participants_count"> | null): PrimaryAction {
  const last = isLastQuestion(session);
  switch (session.current_stage) {
    case 'LOBBY':
      return { action: 'start', label: 'Lancer le quiz' };
    case 'STARTING':
      return { action: null, label: 'C’est parti…', disabled: true };
    case 'QUESTION_OPEN':
    case 'QUESTION_PAUSED':
    case 'QUESTION_CLOSED':
      return { action: 'reveal', label: 'Révéler les résultats' };
    case 'ANSWER_REVEAL':
      if (usesLeaderboard(session)) return { action: 'leaderboard', label: 'Voir le classement' };
      return last
        ? { action: 'finish', label: hasLeaderboard(session) ? 'Résultats finaux' : 'Voir le récap' }
        : { action: 'next', label: 'Question suivante' };
    case 'LEADERBOARD':
      return last
        ? { action: 'finish', label: 'Résultats finaux' }
        : { action: 'next', label: 'Question suivante' };
    case 'FINISHED': {
      const order: ('podium' | 'ranking' | 'recap')[] = hasLeaderboard(session) ? ['podium', 'ranking', 'recap'] : ['recap'];
      const idx = order.indexOf(session.final_view);
      const next = order[idx + 1];
      if (!next) return { action: null, label: 'Partie terminée', disabled: true };
      return {
        action: 'final_view',
        label: next === 'ranking' ? 'Classement complet' : 'Voir le récap',
        args: { view: next },
      };
    }
  }
}

export const STAGE_LABELS: Record<GameStage, string> = {
  LOBBY: 'Salle d’attente',
  STARTING: 'Compte à rebours',
  QUESTION_OPEN: 'Question en cours',
  QUESTION_PAUSED: 'En pause',
  QUESTION_CLOSED: 'Réponses fermées',
  ANSWER_REVEAL: 'Résultats',
  LEADERBOARD: 'Classement',
  FINISHED: 'Terminée',
};

export function isQuestionStage(stage: GameStage) {
  return stage === 'QUESTION_OPEN' || stage === 'QUESTION_PAUSED' || stage === 'QUESTION_CLOSED';
}

/** Should a client ask the server to perform a time-driven transition now? */
export function isTickDue(
  session: Pick<GameSession, 'current_stage' | 'stage_ends_at' | 'question_deadline_at' | 'auto_close_when_all_answered'>,
  nowMs: number,
  live?: Pick<SessionLive, 'answers_count' | 'eligible_count'> | null,
  graceMs = 600,
) {
  if (session.current_stage === 'STARTING' && session.stage_ends_at) {
    return nowMs >= new Date(session.stage_ends_at).getTime();
  }
  if (session.current_stage === 'QUESTION_OPEN' && session.question_deadline_at) {
    if (nowMs >= new Date(session.question_deadline_at).getTime() + graceMs) return true;
    if (session.auto_close_when_all_answered && live && live.eligible_count > 0 && live.answers_count >= live.eligible_count) {
      return true;
    }
  }
  return false;
}
