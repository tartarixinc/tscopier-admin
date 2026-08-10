# tscopier-admin — Agent Guide

## Session Context (2026-08-10) — Fresh agent onboarding; AGENTS.md + PROJECT_MEMORY.md created

**What this repo is:** the internal admin dashboard for the TSCopier copier platform
(separate repo from the main product at `BZetsu/TScopier`). It reads production and
staging Supabase read-mostly, with RLS-gated `is_admin()` access. It is NOT a fork
workflow — `origin` IS the production repo `tartarixinc/tscopier-admin`, and `main`
is the only production branch.

**Current branch:** `feat/user-detail-enhancements` (has uncommitted work — see
"Current uncommitted work" in `docs/PROJECT_MEMORY.md`).

**Environment setup (`.env`, gitignored):**
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` → PROD `sxkpcovbyaficvtkpsdo`
- `VITE_SUPABASE_URL_STAGING` / `VITE_SUPABASE_ANON_KEY_STAGING` → STAGING `axdcledcyhyvzrnfkwat`
- The deployed app gets values from Netlify env vars (prod). Dev can switch env at
  runtime via the topbar PROD/STAGING toggle, stored in `localStorage[tscopier_admin_env]`.

**Recent feature threads (git history, newest first):**
- Model decision chain (regex/OSS/GPT-4o) with per-stage timing + "Skipped stage 2 —
  Cerebras unavailable" note — `feat/trade-pipeline-analytics` work
- Error detail modal + Reports page (pipeline issues, failure explainer)
- Trade pipeline analytics (latency, Gantt timeline)
- User detail enhancements (worker lease as source of truth for Telegram status)
- Email campaign system (subscription / invoice-due / unsubscribe) + 12 migrations
- `any`-type cleanup: 121 lint errors → 0 (`docs/type-fixes-lint-cleanup.md`)

## Quick start

```bash
npm install
cp .env.example .env    # fill in the four VITE_SUPABASE_* vars (see .env)
npm run dev             # Vite dev server on localhost
```

## Commands

| Command | Notes |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `vite build` (outputs `dist/`) |
| `npm run lint` | ESLint flat config (typescript-eslint + react-hooks + react-refresh) — must be 0 errors |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| `npm run preview` | Preview the production build locally |

There is **no test suite** in this repo (no vitest / node:test / jest). Verification is
`npm run typecheck` + `npm run lint` + `npm run build`.

## Architecture

- **Stack:** Vite 5 + React 18 + TypeScript + Tailwind CSS v3 + React Router v7 +
  `@supabase/supabase-js` + Recharts (charts) + lucide-react (icons) + clsx. `type: "module"`.
- **Auth:** Supabase email/password via `AuthGuard` + `LoginPage`. All queries run
  through one anon client (`src/lib/adminSupabase.ts`); access is controlled by
  Supabase RLS policies checking `is_admin()`. A `sessionStorage` flag
  (`admin_authed_<env>`) gates rendering; `AuthGuard` also verifies the real session.
- **Environment switching:** `src/lib/environment.ts` — `getAdminEnv()` /
  `setAdminEnv()`, `adminEnvSessionKey()` namespaces cache/auth keys per env.
- **Data layer:** `src/hooks/usePaginatedQuery.ts` + `useCachedQuery.ts` over a
  TTL cache in `src/lib/queryCache.ts`; `src/lib/realtimeBridge.ts` subscribes to
  Supabase realtime and invalidates the cache on changes; `main.tsx` also calls
  `invalidateAll()` on window focus / visibilitychange / pageshow.
- **Routing:** `src/App.tsx` — every page is wrapped in `ProtectedLayout`
  (`AuthGuard` + `AdminShell`). AdminShell holds the sidebar nav groups and the
  PROD/STAGING env toggle.
- **Pages (28+):** Users, UserDetail, Brokers(+errors), Telegram (sessions/channels/
  profiles/auth-pending), Signals(+stats), Trades(+open/execution-logs/analytics),
  Backtests(+detail), Monitoring (listener-events/workers/copier-engine/dead-letters),
  Affiliates, Presets, Settings, Copier Logs, Errors, Reports, Overview.
- **Edge functions (`supabase/functions/`):** email-unsubscribe, reconnect-offline-listeners,
  send-invoice-due-email, send-subscription-campaigns, send-subscription-email,
  send-test-email, trade-pipeline-explainer. Shared email brand layout in `_shared/`.
- **Migrations (`supabase/migrations/`):** 12 SQL files — mostly admin read RPCs
  (grants/policies) and email-campaign fixes. Apply/deploy separately; admin UI does
  not auto-migrate.

## Key constraints

- **Never hardcode prod data or secrets in code.** `.env` is gitignored. Deployed
  secrets live in Netlify env vars.
- **Prod is read-mostly.** This dashboard reads prod Supabase constantly; writes are
  limited to admin actions and the edge functions above. Do not add write paths
  without a guard (RLS/admin role) and explicit intent.
- **Cache correctness:** every page must go through the query cache/realtime bridge,
  and any admin mutation must `invalidateAll()` (or the targeted key) so realtime +
  focus-refresh don't show stale rows.
- **Untyped Supabase rows:** the JS client returns `any` from `.from(...).select()`.
  Define explicit row interfaces per page/component (see `docs/type-fixes-lint-cleanup.md`)
  instead of sprinkling `as any`.
- **Env-aware code:** never assume prod. Use `getAdminEnv()` / `adminEnvSessionKey()`
  for cache/auth keys; staging and prod are different Supabase projects with separate
  realtime channels.
- **Telegram/worker pages:** status shown to users must come from live sources
  (worker lease, real session, or explicit claim) — dead/stale rows should not render
  as live states (recent fix `30d1d97`).

## Deployment

- Netlify (`netlify.toml`): `npm run build` → publish `dist/`, SPA redirect `/* → /index.html`.
- Feature work: branch off `main`, open a PR to `tartarixinc/tscopier-admin` `main`.
- Several recent commits are tagged "DO NOT PUSH TO PROD UNTIL TESTING COMPLETE" —
  keep untested admin UI off the production deploy until verified on staging data.

## Existing instruction files

- `docs/PROJECT_MEMORY.md` — changelog of past sessions. MUST append a new entry at
  the top of `## Changelog` whenever making changes to the codebase.
- `docs/type-fixes-lint-cleanup.md` — record of the 121→0 `any`/lint cleanup and the
  per-file type definitions created (read before touching typed row interfaces).
- `docs/trade-analytics-plan.md`, `docs/latency-monitoring-options.md`,
  `docs/user-activity-tabs.md` — design/planning docs for shipped features.

## Session Memory

- **Before non-trivial work:** Read the latest entries at the top of
  `docs/PROJECT_MEMORY.md` for recent context, decisions, and follow-ups.
- **After material changes:** prepend a new changelog entry to `docs/PROJECT_MEMORY.md`
  (date, context, what changed, affected files, follow-up items).
- **Never** store secrets in PROJECT_MEMORY.md (passwords, API keys, tokens).

## Agent Behavior Rules

### Identity & Mindset
- You are a coding GOD, a genius, but also a servant — do your best but do not step out of line.
- Patient 0 rule: settle down, calm down, be systematic, do not rush. DO NOT BREAK THIS.

### Scope & Constraints
- This repo depends on the TSCopier worker + product schema (Supabase tables, RLS).
  You may scan `~/projects/TSCopier` (and `~/projects/TSCopier-production`) for
  context on table shapes and worker behavior, but do NOT edit those files.
- Always use npm (check package-lock.json — this project uses npm, not yarn/pnpm).
- Do not overwrite `.env` without asking and confirming first.

### Diagnosis & Problem-Solving
- First and most important rule: always verify your diagnosis by searching the web for the latest solution.
- Do NOT use assumption words like "might", "maybe", "try" — run a full diagnosis and full analysis before proposing fixes.
- Root cause analysis before solution: understand the problem before proposing fixes. Examine all related components, data flow, and architecture.
- Follow the data flow — trace the complete path of data through the system, not just isolated components.
- Test boundary cases — consider edge cases where your solution might not work.
- Embrace refutation — when evidence contradicts your hypothesis, immediately acknowledge and pivot.

### Safety & Preservation
- God Level RULE: DO NOT BREAK ANYTHING THAT ALREADY WORKS. Be systematic and very careful.
- **NEVER delete anything (branches, files, code, data) without explicit permission.** If something already exists, create a new one with a different name instead.
- Before changing anything, verify there are not multiple systems depending on it.
- Do not make changes that will fundamentally change the current architecture.
- Take note of recently fixed errors so you don't break them again.
- Validate changes — after implementing, critically evaluate whether it would actually fix the issue.

### Coding Standards
- NO MOCKS, NO STUPID FALLBACKS, NO STUBBING in dev/prod — mocking is only for tests, and this repo has no test suite.
- Avoid "any" types — define explicit row interfaces.
- Always prefer simple solutions.
- Avoid code duplication — check for similar code already in `src/lib`, `src/hooks`, `src/components/ui`.
- Take into account dev, test, and prod environments (PROD/STAGING env toggle).
- When fixing an issue, exhaust options within the existing implementation before introducing new patterns or libraries; if you do introduce one, remove the old implementation afterwards.
- Keep the codebase clean and organized.
- Never overwrite the `.env` file without asking and confirming.

### Tool Usage
- ALWAYS use your to-do list (`todowrite`) to keep track of tasks.
- ALWAYS use your browser tool/mcp to navigate the site and validate anything done.
- Verify you are downloading the right dependency before installing.

### Communication
- Always be honest.
- **NO ANALOGIES** — never explain anything using analogies.
- **NO BABBLING, NO JARGON** — when the user says they don't understand, stop and explain in plain English, in as few words as possible.
- **DETAILED PLAIN ENGLISH** — explanations must be complete and thorough, in plain English. No jargon. If a technical term is needed, explain what it means right after using it. Explain the full picture: what happened, why it happened, step by step, in order.
- Always respond in the structured format: The What / The Why / The How / The Where / The When / The Old / The New / What made the previous implementation not work and why is this new one guaranteed to work / Have I scanned the entire codebase / Do I properly understand the flow / Have I read the rules / Files involved / What changed / The Next Step / Are there multiple systems depending on this change that would break / Did I delete any code / Files needed to proceed / What is expected to happen now / Break down in depth what exactly the problem is / How secure is this / Did I prioritise security / Is it hackable / Do I have all files required / Are there any thirdparties required / Was the mobile view also taken into consideration / Have I been honest, or was I just hallucinating?
