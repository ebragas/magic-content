# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Magic Content scrapes a creator's last-90-day Instagram Reels, analyzes each with Gemini (transcript + topic/category/hook/beats/why-it-works), and serves a durable, queryable library via a dashboard. `CONTEXT.md` is the ubiquitous-language glossary — read it first; every other doc uses those terms precisely (Reel, Content Store, Creator Snapshot, Performance, Virality, Outlier).

## Commands

```bash
npm run dev                          # Next.js dashboard (long-running; the run API needs this, not serverless)
npm run build                        # next build
npm run cli -- <action> [creator]    # pipeline CLI; action = scrape | analyze | refresh | full
npm run typecheck                    # tsc --noEmit
npm test                             # vitest run (whole suite)
npx vitest run lib/core/metrics.test.ts   # single test file
npx vitest run -t "name fragment"         # single test by name
```

The CLI defaults `creator` to the first entry in `config/creators.yaml` (`itsmariahbrunner`); a leading `@` is fine. It writes the `PipelineResult` JSON to stdout and a run-log to stderr.

## Architecture

**Shared pipeline core, thin entry points (ADR-0002).** All behavior lives in `lib/core/`, which is free of CLI/HTTP concerns (no `process.argv`, no `Request`/`Response`). Three thin entry points call the same `pipeline()` function: the CLI (`cli/index.ts`), the `magic-content` skill (which shells out to the CLI), and the Next.js route handler (`app/api/content-pipeline/runs/route.ts`, the dashboard's "Run pipeline" button). When adding pipeline behavior, put it in `lib/core` — never in an entry point.

**Pipeline flow.** `scrape` (Apify → upsert creators/Reels/metrics + a `creator_stats` snapshot) → `analyze` (Gemini, newest-first, capped) → `refresh` (re-pull cheap metrics + new snapshot, recompute derived fields). `full` runs all three in order. `lib/core/index.ts` is the public barrel.

**Unified TypeScript, no build step (ADR-0005).** The exact same `lib/core` source runs under tsx (CLI), vitest (tests), and the Next server (dashboard). Files in `lib/core` use explicit `.js` import specifiers (NodeNext convention) even though they're `.ts`; `next.config.ts` teaches webpack to map `.js` → `.ts`. `better-sqlite3` is a native module marked `serverExternalPackages` and is server-side only.

**Dependency ports / DI seam (HARD INVARIANT #2).** External I/O — Apify, Gemini, Video download/file lifecycle — is expressed as typed *ports* in `lib/core/types.ts` (`ApifyPort`, `GeminiPort`, `VideoPort`, bundled as `Deps`). Real adapters in `lib/core/adapters/` auto-engage via dynamic `import()` when `APIFY_TOKEN` / `GEMINI_API_KEY` are set (so the SDKs never load in tests). Tests fake **only** these ports and drive the *real* pipeline against a *real* in-memory SQLite store (`openStore(":memory:")`), asserting on resulting store state — never internals. With no key and no injected port, the pipeline is a safe no-op ("walking skeleton").

**Content Store.** Durable SQLite at `data/content.db` (gitignored). Three tables — `creators` / `creator_stats` (time-series snapshots) / `reels` — defined as idempotent `CREATE ... IF NOT EXISTS` DDL in `lib/core/store.ts`, mirroring `docs/schema.md` and the row types in `types.ts`. The `Store` interface is the single API surface the pipeline writes through and the dashboard reads through.

**Immutable analysis, refreshed metrics (ADR-0004) + prompt provenance (ADR-0003).** Prompts live as files in `prompts/` and are never inlined. A prompt's version is the SHA-256 (first 12 hex chars) of its *fully-rendered* content — for analysis, that's *after* `config/categories.yaml` is injected, so editing a category definition changes the hash and triggers exactly one re-analysis. On `analyze`, a Reel is re-analyzed only if its analysis is missing/failed or a stored prompt hash differs from current; otherwise it's skipped (a 2nd run analyzes 0 new). `analyze` is capped at `max_analyses_per_run` (newest-first); `refresh` is uncapped (cheap). Cost caps live in `config/settings.yaml`.

## Conventions & gotchas

- **In `app/`, import from specific `lib/core` modules, not the barrel** (`lib/core/index.ts`) — pulling the barrel drags Apify/Gemini SDKs and `import.meta.url` path tricks into the webpack server bundle.
- The run registry (`app/api/content-pipeline/runs/registry.ts`) is a module-level in-memory singleton: the route is `runtime = "nodejs"` + `force-dynamic`, and a second concurrent `POST` is rejected with `409`. The monitor page (`app/runs/page.tsx` + `app/RunMonitor.tsx`) polls `GET runs/{run_id}` (~1–2s) for per-step `steps` progress.
- Apify's hidden-likes sentinel `-1` is normalized to `NULL` (never stored as `-1`).
- `monotonicNowIso()` (store.ts) keeps back-to-back `creator_stats` snapshots in one `full` run from colliding on `UNIQUE(creator_username, captured_at)`.
- Usernames are canonicalized via `normalizeUsername` (lowercase, strip leading `@`) at every boundary — it's the store key.
- vitest excludes `.claude/**` (agent worktrees carry their own copy of the suite), `data/`, and `.next/`.
- Required env (`.env`, copied from `.env.example`): `APIFY_TOKEN`, `GEMINI_API_KEY`.

Read in order when working in an area: `CONTEXT.md` → relevant `docs/adr/` (0001–0005, the "why") → `docs/schema.md` / `docs/build-spec.md` (guardrails, run-API contract, Definition of Done). Editing the analysis prompt? `references/content-strategy-framework.md` is the source of truth for what `prompts/video-analysis.md` extracts (and the backlog for widening it).

## Agent skills

### Issue tracker

Issues and PRDs live in Linear (Content Engine project, Main team), managed via the Linear MCP. See `docs/agents/issue-tracker.md`.

### Triage labels

1:1 with Linear's canonical triage labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
