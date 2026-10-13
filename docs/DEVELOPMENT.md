# Khaliya — developer reference

> This is the detailed engineering reference (local dev, free-tier budgeting, API routes). Some early sections describe
> P0/P1 as first built; later phases (Eval Factory, Evolution, Forge, Discovery, Memory/Court, Red-Team, Studio, Army)
> are summarised in the main [README](../README.en.md). The full architecture plan is kept privately.

Phases **P0 (Foundations)** and **P1 (Agents & Homes)** onwards.
Everything runs on the **Cloudflare Workers free plan** — no R2, no paid add-ons, no card needed — and only
calls **free** LLMs (Gemini free tier, OpenRouter `:free` models, Workers AI free neurons).

> Deploying needs the owner's approval and a separate Cloudflare account (see "Deploy" below). No service is public.

## What's inside

```
khaliya/
├── package.json                 root scripts (delegate to apps/api)
├── scripts/gen-owner-secret.mjs generates the owner TOTP seed + session secret (local only)
├── apps/
│   ├── api/                     Cloudflare Worker (TypeScript, Hono)
│   │   ├── wrangler.toml        free-tier config: D1, SQLite Durable Object, Workers AI, Static Assets, Cron
│   │   ├── migrations/0001_init.sql   D1 registry schema
│   │   ├── src/
│   │   │   ├── index.ts         REST API, owner auth gate, cron + queue handlers
│   │   │   ├── constitution.ts  immutable rules, tiers T0–T4, role ceilings, hard caps, lifecycle
│   │   │   ├── genome/schema.ts genome schema, validation, content-hash ids (g_<sha256>)
│   │   │   ├── registry/        D1 CRUD for lineages/genomes/agents/deployments + starter-org seed
│   │   │   ├── home/AgentHome.ts  Durable Object per agent (SQLite: memory, inbox, tasks, traces)
│   │   │   ├── runtime/loop.ts  perceive → retrieve → plan → act → reflect → memory, with hard caps
│   │   │   ├── llm/             model router (Gemini / OpenRouter :free / Workers AI / mock), key rotation, D1 cache
│   │   │   ├── tools/           tool catalog + Tool Gateway (permission → budget → approval/sandbox → audit)
│   │   │   ├── approvals.ts     owner-only approval queue (T3/T4), T4 needs TOTP step-up
│   │   │   ├── governor/        quota-derived daily caps (70% margin), kill switches, population cap
│   │   │   ├── auth/            TOTP (RFC 6238), signed HttpOnly session cookie, lockout + replay guard
│   │   │   └── audit.ts         append-only, hash-chained audit log
│   │   └── test/                vitest suites (run inside workerd via @cloudflare/vitest-plugin)
│   └── console/public/          owner console: static SPA, Arabic-first RTL + English, no build step
```

### Key design points
- **Genome** = immutable JSON, id = `g_` + first 32 hex of SHA-256 over canonical JSON (excluding `id`, `created_at`;
  `tool_ids` treated as a set). Integrity is re-verified every time a genome is loaded.
- **Lifecycle**: `draft → sandboxed → candidate → champion → retired` (+ `quarantined`). Only the owner changes states;
  promoting to champion moves the role's deployment pointer (rollback = point back).
- **Runtime caps per run** (constitution ceilings; a genome can only lower them): 12 steps, 24k tokens, 8 tool calls,
  16 LLM calls, 90 s wall time. Defaults: 6 / 12k / 5 / 10 / 60 s. A hanging LLM call is cut off at the wall-time cap.
- **Daily caps** come from free-tier quotas × 0.70 (owner can tune 10–90%): global, per agent (25% share), per provider.
- **Capability tiers**: T0 think/memory · T1 internal org tools · T2 sandboxed code · T3 external read · T4 external
  write/spend/publish. T3/T4 always land in the Approval queue; T4 approval additionally needs a fresh TOTP code.
  In P1, approved T4 tools record the decision but perform **no external effect** (`email.send`, `web.publish`,
  `spend.request` are stubs). `http.get` (T3) really fetches once approved (https only, 10 s, 4 KB).
- **Sandboxed** agents get simulated results for T3/T4 — no approval rows, no network.
- **Kill switches**: global + per agent, checked before every phase/step and inside the Tool Gateway.
  The cron health tick auto-pauses an agent with ≥5 failed runs in an hour.
- **Not editable by agents**: the constitution (deep-frozen module), Governor state, approvals, audit, auth.
  No tool id may start with `governor.`, `constitution.`, `audit.`, `approval.`, `auth.`, `budget.`, `kill.`.
  Evaluator / Critic / Auditor lineages are protected from agent writes.
- **Model router**: genome policy → default free chain
  (`gemini-flash-lite-latest` → `gemini-flash-latest` → `gemini-3.5-flash` → OpenRouter `llama-3.3-70b-instruct:free` →
  `deepseek-chat-v3-0324:free` → Workers AI `llama-3.3-70b-instruct-fp8-fast` → `llama-4-scout-17b-16e-instruct`). Rotates keys on 429 (honours `Retry-After`,
  parks a key that returns 401/402/403 for an hour), refuses any OpenRouter model without `:free`, caches
  temperature-0 prompts in D1 for 1 h. With no keys configured it falls back to the deterministic mock provider.
- **Starter org** (seeded as champions, v1): Director, Architect, Researcher, Builder, Evaluator, Critic, Librarian, Auditor.

## Local development

Requirements: Node 20+ (tested with Node 22). No Cloudflare account is needed for local dev or tests.

```bash
cd khaliya/apps/api
npm install                  # .npmrc sets legacy-peer-deps (works around an npm 10 peer-resolution bug)

# local secrets for `wrangler dev` (never committed — .dev.vars is git-ignored)
node ../../scripts/gen-owner-secret.mjs          # prints a TOTP seed + session secret
cat > .dev.vars <<'VARS'
OWNER_TOTP_SECRET="<base32 seed from the script>"
SESSION_SECRET="<session secret from the script>"
LLM_MODE="mock"
VARS

npx wrangler d1 migrations apply khaliya --local
npx wrangler dev             # http://localhost:8787  — console + API on one origin
```

Add the seed to an authenticator app (Google Authenticator, Aegis, 1Password…), open the console, enter the
6-digit code, then **Settings → Create the starter org**. With `LLM_MODE="mock"` everything works offline; to try
real free models locally add `GEMINI_KEY` / `OPENROUTER_KEY` to `.dev.vars` and set `LLM_MODE="auto"`.
(Workers AI is always a remote binding; it is only used as the last fallback.)

### Tests

```bash
cd khaliya/apps/api
npm test                     # vitest inside workerd (Miniflare), D1 + Durable Objects local
npm run typecheck
npm run dryrun               # wrangler deploy --dry-run --outdir dist (bundles, uploads nothing)
```
From the repo root: `npm run check` runs all three.

## Deploy (only after Omar approves — free plan, separate Cloudflare account)

```bash
cd khaliya/apps/api
npx wrangler login                                   # the NEW, separate Cloudflare account
npx wrangler d1 create khaliya                       # copy database_id into wrangler.toml
npx wrangler d1 migrations apply khaliya --remote
node ../../scripts/gen-owner-secret.mjs
npx wrangler secret put OWNER_TOTP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GEMINI_KEY                   # one or more keys, comma-separated
npx wrangler secret put OPENROUTER_KEY               # one or more keys, comma-separated
npx wrangler deploy                                  # API + console on https://khaliya-api.<sub>.workers.dev
```
Then sign in and press **Create the starter org**.

**Console on Cloudflare Pages instead (optional):** set `window.KHALIYA_API_BASE` in
`apps/console/public/config.js` to the Worker URL, set `CONSOLE_ORIGIN` in `wrangler.toml` to the Pages origin
(this switches the cookie to `SameSite=None` and enables CORS with credentials for that origin only), then
`npm run console:pages:deploy` from the repo root. Same-origin (the default) is simpler and stricter.

**Queues (optional):** the free plan includes Queues, but the code does not need them (Durable Object alarms run
queued tasks). To enable: `npx wrangler queues create khaliya-jobs` and uncomment the `[[queues.*]]` blocks.

### Free-tier notes
- Gemini free limits are **per Google Cloud project**, not per key: extra keys only add capacity if they belong to
  different projects. Check your live limits at https://aistudio.google.com/rate-limit and adjust
  `src/governor/quotas.ts` if they differ from the defaults (15 RPM / 1,000 RPD for Flash-Lite).
- OpenRouter `:free` models: 20 RPM; 50 requests/day for accounts that never bought credits. A negative balance can
  make even free models return 402 — the router parks that key and moves on. It never calls paid models.
- Workers AI: 10,000 free neurons/day. The Governor budgets it **in neurons** (cap = margin × 10,000, ledger
  `provider:workers-ai / neurons`): each call reserves its worst case (prompt + full `maxTokens`) at the model's published
  rate and settles to the real token usage afterwards (rates in `src/governor/quotas.ts`, from
  https://developers.cloudflare.com/workers-ai/platform/pricing/). A 1B call costs ~3–8 neurons, a 70B call ~50–250, so
  the small weak-baseline models get thousands of calls while 70B is a last resort.
- Gemini: free quotas are **per model** (and per project). `GEMINI_FREE_RPD` holds conservative per-model defaults
  (ledger `model:gemini:<id>`); the provider cap is their sum. A 429 parks only that model on that key. Non-lite Flash
  models think by default and spend thoughts from `maxOutputTokens`, so the provider sends `thinkingLevel: "low"` plus
  1,024 tokens of headroom; Flash-Lite gets neither (it rejects `thinkingBudget: 0`). Verified live 2026-10-12:
  `gemini-flash-lite-latest`, `gemini-3.5-flash`, `gemini-flash-latest` (intermittent 503 "high demand"); `gemini-2.5-*` return 404 for this key.
- Judges: two distinct models, Gemini first (two Gemini models when available), skipping any model whose daily budget is used up.
- Owner diagnostics: `GET /api/llm/ping?model=` (one real pinned call: ok / latency / model, never a key),
  `GET /api/llm/models?provider=gemini`, `GET /api/llm/budget` (provider / model / neuron usage vs caps).
- D1: 5 M rows read / 100 k rows written per day → the Governor limits runs/day so writes stay under 70%.

## API (all owner-only except `/api/health` and `/api/auth/login`)
Mutating requests need the session cookie **and** the header `x-khaliya: 1` (CSRF guard).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` · `/logout` · `/logout-all` | TOTP sign-in / sign-out / revoke all sessions |
| GET | `/api/overview` | budgets, quota meters, counts, kill state, provider status |
| GET/POST | `/api/agents` | list / create agent from a genome |
| GET | `/api/agents/:id` · `/desk` | agent + genome · desk (task, trace, memory, tools, inbox) |
| PATCH | `/api/agents/:id/status` | lifecycle transition |
| POST | `/api/agents/:id/run` | run a task (`wait: true`) or queue it (DO alarm) |
| POST | `/api/agents/:id/message` · `/kill` · `/resume` | inbox message · per-agent kill switch |
| GET/POST | `/api/genomes` · GET `/api/genomes/:id` · GET `/api/deployments` | registry |
| GET | `/api/runs` · `/api/runs/:id` | runs and traces |
| GET | `/api/approvals?status=pending` | approval inbox |
| POST | `/api/approvals/:id/approve` · `/reject` | owner decision (`{code}` required for T4) |
| GET/POST | `/api/governor` · `/kill` · `/caps` | constitution, caps, global kill switch, cap tuning |
| GET | `/api/audit` · `/api/audit/verify` | audit log, hash-chain verification |
| GET | `/api/tools` · `/api/settings` · POST `/api/seed` | tool catalog, settings (no secrets), seed starter org |

### Eval Factory — `/api/evals` (owner-only)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/evals/suites` | suites with item counts by split/status |
| GET | `/api/evals/suites/:id/items?status=&split=&limit=` | items (owner view includes references + checkers) |
| GET | `/api/evals/items/:id` | item, validation report, results |
| POST | `/api/evals/seed` `{suites?, max_calls?}` | idempotent seeding of the starter suites |
| POST | `/api/evals/suites/:id/saturation` `{ladder?, count?}` | saturation check (+ author harder items) |
| POST | `/api/evals/suites/:id/run` `{agent_id? \| genome_id?}` | score a genome on the private split |
| POST | `/api/evals/items/:id/retire` · `/api/evals/retire-flaky` | retirement |

### Evolution Loop — `/api/evolution` (owner-only)
Engine actions hold the global evolution lock; a held lock answers **409** `{status:"locked", lock}`. Kill switch
on → **423** `lab_killed`; lab budget → **429** `lab_tick` / `lab_daily`.

| Method | Path | Response / purpose |
|---|---|---|
| GET | `/api/evolution/status` | `{lock, kill_global, roles:[{role, champion:{agent_id,genome_id,version,rating,rd}, canary\|null, candidates_count}], last_tick, auto}` |
| GET | `/api/evolution/proposals?role=&status=&limit=` | `{proposals:[{id, role, operator, parent_genome_id, genome_id, status, stage, reasons[], scores, created_at, updated_at, …}]}` — `status` = `open` (in pipeline) or the stage (`canary`, `promoted`, `rolled_back`, `rejected`, `lost`); filter accepts `open`, `closed` or any stage |
| GET | `/api/evolution/proposals/:id` | `{proposal (+reports), genome, parent_genome, diff, tournament, matches}` |
| GET | `/api/evolution/leaderboard?role=` | `{ratings:[{genome_id, agent_id, role, version, rating, rd, vol, matches, conservative, status}]}` sorted by `conservative = rating − 2·rd` |
| GET | `/api/evolution/tournaments?role=&limit=` · `/api/evolution/tournaments/:id` | list (with `match_count`) · `{tournament, proposal_id, matches}` |
| GET | `/api/evolution/promotions?role=&limit=` | `{promotions:[…]}` kinds `canary_start`, `promote`, `auto_rollback`, `owner_rollback` |
| GET | `/api/evolution/operators?role=` | `{operators:[{id, alpha, beta, mean, trials, wins, roles}]}` (Thompson posterior) |
| GET | `/api/evolution/notes?role=&outcome=&limit=` | `{notes:[…]}` evolution notes fed back to mutators |
| POST | `/api/evolution/tick` `{roles?, max_proposals? (0-5), max_calls?}` | one engine tick → `TickSummary` |
| POST | `/api/evolution/generation` `{role, operator?, max_calls?}` | one generation → `GenerationResult` |
| POST | `/api/evolution/canaries/:id/evaluate` `{samples?, max_calls?}` | advance a canary (promote / auto-rollback / keep running) |
| POST | `/api/evolution/rollback` `{role, to_genome_id}` | owner rollback (audited, `owner_rollback` promotion) |
| POST | `/api/evolution/proposals/:id/reject` `{reason?}` | owner rejects an open/canary proposal (audited) |

Automatic evolution: set `EVOLUTION_AUTO = "on"` in `[vars]` to let the half-hourly cron run one tick per hour
(1 proposal). Default `"off"`.

### Background jobs — `/api/jobs` (owner-only)
Long lab work never runs inside one HTTP request. `POST /api/evals/seed`, `POST /api/evals/suites/:id/saturation`,
`POST /api/evolution/generation` and `POST /api/evolution/tick` answer **202 `{job_id, job, poll}`** at once
(`{"sync": true}` keeps the old single-request behaviour for tests / tiny budgets). The `JobRunner` Durable Object
(singleton, alarm-driven, free plan) runs one chunk per invocation — ~12 LLM calls or 20 s, or exactly one evolution
stage — saves a resumable cursor in D1 (`jobs`, migration 0003) and re-arms itself; the half-hourly cron re-kicks it.
A failing step restores its cursor (no candidate is skipped); provider outages back off 30 s → 4 min (8 tries), other
errors fail after 3 chunks; budget / daily cap / kill switch end the job with `stopped` = `budget` | `daily_budget` |
`killed`. Seeding is idempotent, so a stopped seed job is simply started again later.
- `GET /api/jobs?status=&kind=&limit=` · `GET /api/jobs/:id` (progress {done,total,pct}, message, partial result) ·
  `POST /api/jobs/:id/cancel`. The console shows a progress dock for every running job.

## What's next (P2+)
Eval Factory (suites, checkers, judge panel) → Evolution loop (mutations, tournaments, Elo, canary/rollback) →
Tool Forge (QuickJS-WASM sandbox) → org memory/Vectorize → lineage tree → Ops Copilot.
