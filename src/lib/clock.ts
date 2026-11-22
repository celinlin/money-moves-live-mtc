// Server clock synchronisation. Every countdown is computed from server
// timestamps (deadline − serverNow), so all screens agree regardless of each
// device's local clock.
import { supabase } from './supabase';

let offsetMs = 0; // serverTime − localTime
let bestRtt = Infinity;
let lastSync = 0;
let syncing: Promise<void> | null = null;

export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function getClockOffset() {
  return offsetMs;
}

/** NTP-style estimate from a single round trip. Exported for unit tests. */
export function estimateOffset(t0: number, server: number, t1: number) {
  const rtt = t1 - t0;
  return { rtt, offset: server - (t0 + rtt / 2) };
}

/** Record a sample; keeps the lowest-latency sample (most accurate). */
export function recordSample(t0: number, server: number, t1: number) {
  const { rtt, offset } = estimateOffset(t0, server, t1);
  // Old samples become less trustworthy over time (clock drift).
  const stale = Date.now() - lastSync > 5 * 60_000;
  if (rtt <= bestRtt * 1.5 || stale) {
    if (rtt < bestRtt || stale) bestRtt = rtt;
    offsetMs = offset;
    lastSync = Date.now();
  }
}

async function sampleOnce() {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc('server_time');
  const t1 = Date.now();
  if (error || !data) return;
  recordSample(t0, new Date(data as string).getTime(), t1);
}

export function syncClock(samples = 4): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    for (let i = 0; i < samples; i++) {
      try {
        await sampleOnce();
      } catch {
        /* offline: keep previous offset */
      }
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Remaining milliseconds until an ISO deadline, by the server clock. */
export function remainingMs(deadlineIso: string | null | undefined): number {
  if (!deadlineIso) return 0;
  return Math.max(0, new Date(deadlineIso).getTime() - serverNow());
}
