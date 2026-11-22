const MESSAGES: Record<string, string> = {
  SESSION_NOT_FOUND: 'Partie introuvable. Vérifie le code ou demande à l’animatrice.',
  SESSION_FULL: 'La partie est complète.',
  NICKNAME_TAKEN: 'Ce prénom est déjà pris dans la partie. Ajoute une initiale !',
  INVALID_NICKNAME: 'Entre un prénom (24 caractères max).',
  PARTICIPANT_REMOVED: 'Tu as été retirée de la partie par l’animatrice.',
  NOT_A_PARTICIPANT: 'Tu ne fais pas partie de cette partie.',
  QUESTION_CLOSED: 'Temps écoulé : la question est fermée.',
  QUESTION_PAUSED: 'La question est en pause, réessaie dans un instant.',
  QUESTION_NOT_ACTIVE: 'Cette question n’est plus active.',
  NOT_ELIGIBLE: 'Tu joues dès la prochaine question.',
  INVALID_ANSWER: 'Réponse invalide.',
  NOT_AUTHORIZED: 'Action réservée à l’animatrice connectée.',
  NOT_AUTHENTICATED: 'Connexion requise.',
  STALE_STATE: 'L’état de la partie a changé entre-temps. Écran mis à jour.',
  INVALID_TRANSITION: 'Cette action n’est pas possible à cette étape.',
  NO_MORE_QUESTIONS: 'C’était la dernière question.',
  QUIZ_NOT_FOUND: 'Quiz introuvable.',
  QUIZ_EMPTY: 'Ajoute au moins une question avant de lancer une session.',
  INVALID_ARGUMENT: 'Valeur invalide.',
};

export function errorCode(err: unknown): string {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  const code = Object.keys(MESSAGES).find((k) => msg.includes(k));
  return code ?? (msg.startsWith('INVALID_QUIZ') ? 'INVALID_QUIZ' : 'UNKNOWN');
}

export function friendlyError(err: unknown): string {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  if (msg.startsWith('INVALID_QUIZ:')) return `Quiz invalide : ${msg.slice('INVALID_QUIZ:'.length).trim()}`;
  const code = errorCode(err);
  if (code !== 'UNKNOWN') return MESSAGES[code];
  if (/fetch|network|Failed to fetch|NetworkError/i.test(msg)) return 'Connexion instable. Nouvel essai…';
  return msg || 'Une erreur est survenue.';
}

export function isNetworkError(err: unknown): boolean {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  return /fetch|network|timeout|Failed to fetch|NetworkError|Load failed/i.test(msg);
}
