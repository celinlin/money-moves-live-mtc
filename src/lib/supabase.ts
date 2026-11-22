import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// VITE_* names, or the NEXT_PUBLIC_* names injected by the Vercel ↔ Supabase integration.
const env = import.meta.env as Record<string, string | undefined>;
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Participants keep their anonymous identity across refreshes/reconnects.
    storageKey: 'mml-auth',
  },
  realtime: {
    params: { eventsPerSecond: 20 },
    heartbeatIntervalMs: 15000,
  },
});

/** Ensure there is an auth session; participants get a durable anonymous identity. */
export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return anon.session!;
}

/** Call an RPC and throw on error, returning typed data. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}
