#!/usr/bin/env node
// Applies supabase/migrations/*.sql to the database during the Vercel build.
// Uses the POSTGRES_URL_NON_POOLING variable injected by the Vercel ↔ Supabase
// integration, so database credentials never leave Vercel. Each migration runs
// once, in a transaction, and is recorded in public._mml_migrations.
// Skips silently when no database URL is configured (local builds, CI).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.MIGRATIONS_DATABASE_URL;
if (!raw) {
  console.log('[migrate] No database URL configured — skipping migrations.');
  process.exit(0);
}

const url = new URL(raw);
url.searchParams.delete('sslmode');
url.searchParams.delete('supa');
const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } });

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

try {
  await client.connect();
  await client.query(`create table if not exists public._mml_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  await client.query('alter table public._mml_migrations enable row level security');
  await client.query('revoke all on public._mml_migrations from anon, authenticated');
  const { rows } = await client.query('select name from public._mml_migrations');
  const done = new Set(rows.map((r) => r.name));
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[migrate] Applying ${f}…`);
    await client.query('begin');
    try {
      await client.query(readFileSync(path.join(dir, f), 'utf8'));
      await client.query('insert into public._mml_migrations (name) values ($1)', [f]);
      await client.query('commit');
      applied++;
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${f}: ${err.message}`);
    }
  }
  console.log(`[migrate] Database up to date (${applied} applied, ${files.length - applied} already present).`);
} catch (err) {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
