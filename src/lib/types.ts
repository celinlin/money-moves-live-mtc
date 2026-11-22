export type GameStage =
  | 'LOBBY'
  | 'STARTING'
  | 'QUESTION_OPEN'
  | 'QUESTION_PAUSED'
  | 'QUESTION_CLOSED'
  | 'ANSWER_REVEAL'
  | 'LEADERBOARD'
  | 'FINISHED';

export type QuestionKind = 'quiz' | 'poll';
export type FinalView = 'podium' | 'ranking' | 'recap';

export interface PublicOption {
  id: string;
  position: number;
  text: string;
}

export interface PublicQuestion {
  index: number;
  kind: QuestionKind;
  allow_multiple: boolean;
  text: string;
  image_url: string | null;
  time_limit_ms: number;
  options: PublicOption[];
}

export interface QuestionResults {
  total_answers: number;
  correct_count: number;
  counts: Record<string, number>;
  correct_option_ids: string[];
  explanation: string | null;
}

export interface LeaderboardEntry {
  id: string;
  nickname: string;
  score: number;
  rank: number;
  previous_rank: number | null;
  correct_count: number;
}

export interface RecapQuestion {
  index: number;
  kind: QuestionKind;
  allow_multiple: boolean;
  text: string;
  total_answers: number;
  options: { id: string; text: string; position: number; count: number; is_correct: boolean }[];
}

export interface PublicState {
  quiz_title?: string;
  question_count?: number;
  show_leaderboard?: boolean;
  question?: PublicQuestion;
  reveal?: QuestionResults;
  leaderboard?: LeaderboardEntry[];
  recap?: RecapQuestion[];
  final_view?: FinalView;
}

export interface GameSession {
  id: string;
  quiz_id: string | null;
  host_id: string;
  game_pin: string;
  quiz_title: string;
  show_leaderboard: boolean;
  status: 'active' | 'finished';
  current_stage: GameStage;
  current_question_index: number;
  question_count: number;
  state_version: number;
  question_started_at: string | null;
  question_deadline_at: string | null;
  paused_remaining_ms: number | null;
  stage_ends_at: string | null;
  time_override_sec: number | null;
  auto_close_when_all_answered: boolean;
  final_view: FinalView;
  public_state: PublicState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface SessionLive {
  session_id: string;
  question_index: number;
  answers_count: number;
  eligible_count: number;
  participants_count: number;
  connected_count: number;
  updated_at: string;
}

export interface Participant {
  id: string;
  session_id: string;
  nickname: string;
  total_score: number;
  correct_answers_count: number;
  correct_time_ms: number;
  rank: number | null;
  previous_rank: number | null;
  eligible_from_index: number;
  removed: boolean;
  joined_at: string;
  last_seen_at: string;
}

export interface PlayerState {
  joined: boolean;
  removed?: boolean;
  state_version?: number;
  participants_count?: number;
  participant?: {
    id: string;
    nickname: string;
    total_score: number;
    rank: number | null;
    previous_rank: number | null;
    correct_count: number;
    eligible_from_index: number;
  };
  answer?: {
    question_index: number;
    selected_option_ids: string[];
    submitted_at: string;
    is_correct: boolean | null;
    points: number | null;
  } | null;
}

export interface SessionQuestionPrivate {
  id: string;
  session_id: string;
  question_index: number;
  kind: QuestionKind;
  allow_multiple: boolean;
  question_text: string;
  image_url: string | null;
  time_limit_sec: number;
  explanation: string | null;
  options: { id: string; position: number; text: string; is_correct: boolean }[];
  effective_time_limit_sec: number | null;
  opened_at: string | null;
  closed_at: string | null;
  revealed: boolean;
  results: QuestionResults | null;
}

export interface QuizRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  show_leaderboard: boolean;
  is_sample: boolean;
  created_at: string;
  updated_at: string;
}
