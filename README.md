# Money Moves Live

A real-time live quiz and poll app, Kahoot-style, in the visual identity of *Money Talks club*.

- **Participants** join from their phone by scanning the single QR code shown in the lobby, then type their first name. There's no account and no email.
- **The presenter** runs the game from a control room (`/host/session/:id`) or directly from the projected screen (`/stage/:code`). The stage has a discreet control bar: ← · pause · **primary action (Space)** · progress · timer · Terminer · Réinitialiser.
- **Two question types**:
  - *Quiz*: one correct answer, scored, counts toward the leaderboard.
  - *Sondage* (poll): anonymous, single or multiple choice, up to 8 answers.

Everything is real multiplayer. The server is authoritative for the timer, transitions, scoring and ranking.

---

## Architecture

```
React + Vite + TypeScript + Tailwind v4 (shadcn-style components on Radix) + Framer Motion
        │  supabase-js (RPC + Realtime postgres_changes)
        ▼
Supabase: Postgres + RLS + Realtime + Auth (email hosts, anonymous players) + Storage (images)
```

**Why plain Postgres functions rather than Edge Functions?** Every sensitive action (`join_session`, `submit_answer`, `host_action`, `tick_session`…) is a `SECURITY DEFINER` PL/pgSQL function. Each one runs in a single transaction, right next to the data, with row locks:

- **Atomicity.** A transition and its effects either all happen or none do.
- **No race conditions.** Answers take a `FOR SHARE` lock on the session and transitions take `FOR UPDATE`. So no answer can be accepted after a question closes, and two transitions can never interleave.
- **Idempotency.** Answers are unique per (participant, question), and retries return the answer already recorded.
- **Double-click and multi-tab protection.** Every presenter command carries the `state_version` it was based on. A stale command is rejected with `STALE_STATE`.
- **No server to deploy** beyond Supabase.

### Real-time synchronisation

| Piece | Mechanism |
|---|---|
| Game state | One `game_sessions` row per game. Each transition rewrites `public_state`, a JSON object holding **only** what participants may see at that stage, in a single UPDATE, and increments `state_version`. |
| Distribution | Realtime `postgres_changes` on that row. Clients ignore any version ≤ the one they already have, so out-of-order or duplicate events have no effect. |
| Counters (answers, connected players) | A separate `session_live` table, watched only by the host and stage, so 100 answers don't fan out to 100 phones. |
| Recovery | Snapshot on load and on every (re)subscription, a safety poll (10 s when healthy, 2 s when degraded), and immediate resync on `visibilitychange` / `online`. |
| Timer | The server stores `question_deadline_at`. Clients estimate the server clock offset (NTP-style) and display `deadline − serverNow`. Pause saves the remaining time; resume computes a new deadline. |
| Automatic close | `tick_session()`: when the deadline passes (+500 ms grace) or everyone has answered, the host or stage asks the server, which checks its own clock. Phones also ask, with a delay, so the game keeps going even if the presenter's tab crashes. |
| Identity | Supabase anonymous auth, persisted in the browser. Refreshing or losing the network gives back the same participant, the same score and the right screen. |
| Late joiners | They watch the question in progress and play from the next one. |
| Confidentiality | Correct answers and future questions never leave the server before the reveal. `submit_answer` doesn't return whether the answer is correct, and scores are only added at the reveal. |

### Scoring
Correct answer: `500 + round(500 × remaining_time / duration)`, between 500 and 1000 points. Wrong answer, no answer or late answer: 0. Totals are **recomputed** from the answers of revealed questions (never incremented), so a recalculation can never double-count.

Tie-breaks, in order: score ↓, correct answers ↓, total time on correct answers ↑, join time ↑, id ↑.

---

## Project structure

```
supabase/
  config.toml                      local config (anonymous sign-ins enabled, raised rate limits)
  migrations/
    20261122000100_schema.sql      tables, RLS, realtime publication, images bucket
    20261122000200_game_engine.sql state machine, scoring, RPCs, privileges
    20261122000300_samples.sql     sample quizzes (11-question poll + scored finance quiz)
src/
  pages/
    JoinPage.tsx                   /            — code + first name
    PlayPage.tsx                   /play/:code  — participant game
    StagePage.tsx                  /stage/:code — projected screen (+ host control bar)
    host/                          /host, /host/quizzes, /host/quizzes/:id/edit,
                                   /host/session/:id, /host/sessions, /host/sessions/:id/results
  components/{ui,game,host,play,brand}
  hooks/useGameSession.ts          realtime sync (snapshot + versions + fallback)
  hooks/useClock.ts, useAutoTick.ts, useHostControls.ts
  lib/stateMachine.ts, scoring.ts, quizDocument.ts (JSON/CSV import-export), clock.ts, sound.ts
  config/brand.ts                  wordmark / hero copy in one place
tests/
  unit/          29 tests  (scoring, ranking, state machine, timers, import/export, CSV)
  integration/   17 tests  (real SQL engine + RLS, concurrency)
  e2e/            1 full scenario test (Playwright, real Supabase)
scripts/load-test.mjs              N real players over realtime
public/templates/quiz-template.csv CSV import template
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Public **anon / publishable** key. Never the `service_role` key. |
| `VITE_PUBLIC_APP_URL` | recommended | Public URL encoded in the QR code (e.g. `https://quiz.example.com`). Defaults to the current origin. |
| `VITE_ALLOW_HOST_SIGNUP` | no | `false` hides the "Créer un compte" link (see security notes). |

---

## Running locally

Prerequisites: Node 20+, Docker, [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
```

```bash
supabase start
```

```bash
supabase status -o env
```

Copy `API_URL` and `ANON_KEY` from that output into `.env.local`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<ANON_KEY>
```

```bash
npm run dev
```

Then:
1. Open http://localhost:5173/host, create a presenter account, and start the sample quiz.
2. Click **Écran de projection** and press F for fullscreen.
3. Join from your phone. On the same Wi-Fi, use `npm run dev` with `VITE_PUBLIC_APP_URL=http://<your-lan-ip>:5173` so the QR code points to a reachable address.

`supabase db reset` reapplies all migrations from scratch.

---

## Deployment (Supabase Cloud + Vercel)

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com). Choose the region closest to your audience.
2. Apply the migrations:

   ```bash
   supabase login
   ```

   ```bash
   supabase link --project-ref <ref>
   ```

   ```bash
   supabase db push
   ```

3. **Authentication → Sign In / Providers**: enable **Anonymous sign-ins**. This is required for participants.
4. **Authentication → Rate Limits**: raise **anonymous sign-ins per hour per IP** (default 30) to at least **500**. ⚠️ At a live event every phone shares the venue Wi-Fi's IP address; the default limit would block anyone after the 30th participant.
5. **Authentication → URL Configuration**: set *Site URL* to your Vercel domain.
6. Email/password provider: keep it enabled for presenters.
7. Realtime: the migration adds the tables to the `supabase_realtime` publication. Check your plan's quotas (concurrent connections and messages per second). For an event with 100+ people, a paid plan gives comfortable headroom.

### 2. Vercel
1. Import the repo. `vercel.json` already sets up the Vite build and the SPA rewrite.
2. Add the environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_APP_URL`).
3. Deploy, then create your presenter account at `https://<domain>/host`.
4. **After that**: in Supabase, disable new sign-ups (*Authentication → Sign In / Providers → Allow new users to sign up*), and set `VITE_ALLOW_HOST_SIGNUP=false`. Anonymous sign-ins for participants stay active.

### Before the event (checklist)
- [ ] Use the quiz editor's preview (**Aperçu** button) to check every question, the correct answer, the timer and images.
- [ ] Run a test game with 2–3 phones on the venue's Wi-Fi.
- [ ] Anonymous rate limit raised (step 1.4).
- [ ] Stage open in fullscreen (F). Sound can be toggled with the speaker icon.

---

## Usage

- **Space / Entrée**: primary action (Lancer → Révéler les résultats → Voir le classement → Question suivante → Résultats finaux / Voir le récap)
- **P**: pause / resume the timer for everyone
- **F**: fullscreen
- **H** (stage): hide or show the control bar

Shortcuts are ignored while typing in a field and don't repeat when a key is held down.

**Flow:**
1. Lobby (QR + code).
2. 3-2-1 countdown.
3. Question. It closes automatically at the end of the timer or once everyone has answered (this can be switched off).
4. **Manual** reveal: bars with %, correct answer highlighted, explanation.
5. Leaderboard (scored questions).
6. Next question.
7. At the end: podium with confetti → full leaderboard → recap.

**Other features:**
- The **timer** menu sets the same duration for every question on the fly, or keeps each question's own duration.
- **Réinitialiser** returns to the lobby, keeps participants, and clears answers. It asks for confirmation.
- **Terminer** asks for confirmation.
- The presenter can remove a participant, for example for an inappropriate first name.
- **Previous question** (←) goes back to the previous question's results. A question that was never answered becomes "unplayed" again.

**Import** (JSON or CSV, template in `public/templates/quiz-template.csv`): validated with error messages that give the line or question number. Inside the editor, you choose between *Ajouter* (append) and *Remplacer* (replace, explicitly confirmed), and nothing is saved until you click **Enregistrer**. Export to JSON or CSV.

**History** (`/host/sessions`): rankings, per-question results, % correct answers, distribution, **CSV export**, and **Rejouer**, which starts a new session with a new code. Results are never overwritten: each session keeps a frozen copy of its questions. Poll answers are exported as aggregates only ("c'est anonyme").

---

## Tests

```bash
npm test
```

Unit tests: 29.

```bash
npm run test:db
```

Integration tests: 17. Requires `supabase start`.

```bash
npm run test:e2e
```

Full Playwright scenario. Requires `supabase start` and `.env.local`.

```bash
SUPABASE_ANON_KEY=<key> npm run load-test -- --players 100 --questions 4
```

Load test against the local stack.

### Results from the most recent run (local Supabase stack, Docker)

| Suite | Result |
|---|---|
| Unit (Vitest) | **29/29** ✅ |
| Integration (real Postgres + RLS) | **17/17** ✅ |
| E2E (Playwright: host + stage + 3 phones) | **1/1** ✅ |
| Load test, 100 players × 4 questions | **PASS** ✅ |

The integration tests cover: validation, RLS (a participant can't read the answer key, other people's answers, or modify a score), registration, duplicate first names, idempotent rejoin, timer expiry, late answers rejected, pause/resume, auto-close, late joiners, stale or invalid commands, reset, 100 simultaneous answers (each submitted twice), 5 concurrent identical presenter commands (exactly one applied), answers vs. question closing (none accepted after closing), and tie-breaking.

The E2E test covers:
1. The presenter creates a quiz in the editor, then starts a session.
2. The stage opens; 3 phones join; a duplicate first name is refused.
3. Synchronised launch.
4. Answers with a live counter; participant refresh **and** presenter refresh mid-question.
5. Auto-close, then reveal with correct/incorrect and points on phones.
6. Leaderboard, then next question via the Space key.
7. A participant goes offline and comes back with the same identity.
8. Close at the end of the timer, then podium → full leaderboard → recap.
9. Results page and CSV export.

Load test, 100 real players (100 anonymous identities and 100 WebSockets):
- Realtime latency from presenter action to each phone: **p50 144 ms, p95 198 ms** (1,600 deliveries; 0 players missed a state).
- Answer submission: p50 4 ms.
- 400/400 answers stored, **0 duplicates** (10% of players deliberately submit twice), **0 score discrepancies**, 100/100 unique ranks.

> ⚠️ These measurements come from a **local** stack (client and server on the same machine). In production, add the network latency to your Supabase region and your plan's Realtime quotas. Re-run `scripts/load-test.mjs` against a staging project before a large event.

---

## Known limitations

- The interface is in French: copy is centralised in the components and in `src/config/brand.ts`, but there's no i18n system.
- Participant names appear on the projected screen during the lobby only for scored quizzes, and only when the stage is opened from the presenter's account. Polls stay anonymous.
- Sound effects are synthesised with the Web Audio API (no external assets). They're silent until the first interaction, because of browser autoplay rules.
