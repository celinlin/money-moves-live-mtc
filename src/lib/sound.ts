// Original synthesized sound effects (Web Audio, no external assets).
// The AudioContext is only created/resumed after a user gesture, so browser
// autoplay policies can never break the game — sounds simply stay silent.

type Cue = 'tick' | 'tap' | 'reveal' | 'correct' | 'wrong' | 'leaderboard' | 'start' | 'fanfare' | 'join';

const STORAGE_KEY = 'mml-sound';
let ctx: AudioContext | null = null;
let muted = readMuted();
const listeners = new Set<(m: boolean) => void>();

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'off';
  } catch {
    return false;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(STORAGE_KEY, m ? 'off' : 'on');
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(m));
  if (!m) unlockAudio();
}

export function onMutedChange(cb: (m: boolean) => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function unlockAudio() {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

if (typeof window !== 'undefined') {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.12) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

export function play(cue: Cue) {
  if (muted || !ctx || ctx.state !== 'running') return;
  switch (cue) {
    case 'tick':
      tone(880, 0, 0.08, 'triangle', 0.06);
      break;
    case 'tap':
      tone(660, 0, 0.07, 'sine', 0.08);
      break;
    case 'join':
      tone(740, 0, 0.09, 'sine', 0.05);
      tone(988, 0.07, 0.12, 'sine', 0.05);
      break;
    case 'start':
      tone(523, 0, 0.12, 'triangle');
      tone(659, 0.12, 0.12, 'triangle');
      tone(784, 0.24, 0.25, 'triangle');
      break;
    case 'reveal':
      tone(392, 0, 0.18, 'triangle', 0.1);
      tone(587, 0.1, 0.3, 'sine', 0.1);
      break;
    case 'correct':
      tone(660, 0, 0.12, 'sine');
      tone(990, 0.1, 0.25, 'sine');
      break;
    case 'wrong':
      tone(330, 0, 0.18, 'sine', 0.08);
      tone(294, 0.14, 0.25, 'sine', 0.07);
      break;
    case 'leaderboard':
      [440, 554, 659, 880].forEach((f, i) => tone(f, i * 0.07, 0.16, 'triangle', 0.07));
      break;
    case 'fanfare':
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.28, 'triangle', 0.1));
      break;
  }
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
