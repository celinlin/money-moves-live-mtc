// Device identity for players: the secret token issued by join_session.
// Persisted in localStorage so a refresh / app switch / reconnect restores the
// same participant; an in-memory copy keeps the game working when storage is
// unavailable (private browsing restrictions).
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: memory only */
  }
}

export function sessionIdForPin(pin: string) {
  return read(`mml-session:${pin}`);
}

export function playerToken(sessionId: string | null | undefined) {
  return sessionId ? read(`mml-token:${sessionId}`) : null;
}

export function saveIdentity(pin: string, sessionId: string, token: string) {
  write(`mml-session:${pin}`, sessionId);
  write(`mml-token:${sessionId}`, token);
}
