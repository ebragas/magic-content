# Magic Content

A content-intelligence system that scrapes a creator's Instagram Reels, analyzes each one with AI (Gemini transcription + visual/structural analysis), and surfaces — per Reel — what it was about and why it worked, so you can model a creator's approach on your own content. It's a durable library (a queryable Content Store + a dashboard), not a one-shot report generator.

**Stack:** unified TypeScript (ADR-0005) — a Next.js app (dashboard + API), a TS CLI, and a shared pipeline core, all one language. SQLite via `better-sqlite3`, Apify via `apify-client`, Gemini via `@google/genai`, with an optional Anthropic leg (Claude) for FAQ clustering and draft generation.

> **Status:** the full pipeline is implemented and green (`npx tsc --noEmit`, `npm test`, `next build`): the Content Store, `scrape`/`analyze`/`refresh`/`full` shared core, the CLI, the Next.js dashboard, the `/content-pipeline/runs` API + "Run pipeline" button, and the Claude skill. External I/O (Apify, Gemini, video download) is dependency-injected and faked at the `lib/core` seam in tests; the real adapters engage automatically once the matching API keys are set.

## How it works (one breath)

`scrape` (Apify) → upsert creators + Reels + metrics → `analyze` (Gemini, newest-first, capped) → transcript + topic + category + hook + beats → store. `refresh` re-pulls cheap metrics any time without re-analyzing. The Next.js dashboard reads the store, and its "Run pipeline" button calls the same core function the CLI does.

## Quick start

```bash
git clone <your-fork-url> magic-content && cd magic-content
npm install
cp .env.example .env            # then fill in your API keys (see "Required keys")

# Edit config/creators.yaml to point at the Instagram handle(s) you want to track.

npm run dev                     # dashboard at http://localhost:3000
npm run cli -- full <creator>   # or run the pipeline from the terminal
```

`npm run cli -- <action> [creator]` where `action` is `scrape` | `analyze` | `refresh` | `full`; `creator` defaults to the first entry in `config/creators.yaml`. The dashboard's "Run pipeline" button invokes the same core, so `npm run dev` must be running for it to work.

Without API keys the pipeline is a safe no-op (the dependency-injected ports stay faked) — useful for running the test suite (`npm test`) and exploring the code.

## Repo layout

```
magic-content/
├── README.md                  ← you are here: orientation + build path
├── CONTEXT.md                 glossary (the project's ubiquitous language)
├── CLAUDE.md                  agent instructions (issue tracker, domain docs)
├── package.json               Next.js app + CLI (one package)
├── tsconfig.json
├── next.config.ts             marks better-sqlite3 as a server external package
├── .env / .env.example        APIFY_TOKEN, GEMINI_API_KEY, optional ANTHROPIC_API_KEY
├── config/
│   ├── categories.yaml        the 7-bucket Category enum + per-bucket definitions (governed)
│   ├── creators.yaml          tracked creators + the 90-day scrape window
│   └── settings.yaml          run guardrails (results_limit, max_analyses_per_run), Gemini model
├── prompts/
│   ├── transcription.md       verbatim transcript prompt
│   └── video-analysis.md      lean-core analysis prompt (Category list injected from config)
├── references/
│   └── content-strategy-framework.md   researched signal framework (the analysis backlog)
├── docs/
│   ├── schema.md              Content Store schema: creators / creator_stats / reels
│   ├── build-spec.md          guardrails · prompt-hashing · run API · Definition of Done · env
│   └── adr/                   numbered architectural decisions (the "why")
├── lib/core/                  the shared pipeline core, server-side only (ADR-0002)
│   ├── store.ts               SQLite (better-sqlite3): schema, upsert, queries
│   ├── scrape.ts              Apify: reels + profile + top comments
│   ├── analyze.ts             Gemini: transcribe + analyze (download → upload → delete → thumbnail)
│   ├── metrics.ts             derived: performance · outlier · virality
│   └── pipeline.ts            scrape / analyze / refresh / full — the core functions
├── cli/
│   └── index.ts               thin CLI over lib/core (run via tsx; built to a bin)
├── app/                       Next.js dashboard + API
│   ├── page.tsx               the dashboard (table, thumbnails, links, "Run pipeline" button)
│   └── api/content-pipeline/runs/route.ts   POST (start run) + GET status — calls lib/core
├── data/                      content.db + thumbnails/   (gitignored)
└── .claude/skills/magic-content/   thin skill wrapper over the CLI
```

## Docs, in reading order

1. **[CONTEXT.md](./CONTEXT.md)** — the language. Read first; every other doc uses these terms precisely.
2. **[docs/adr/](./docs/adr/)** — the architectural decisions and *why* (durable store, shared TS pipeline core, externalized prompts + provenance, immutable-analysis/refreshed-metrics, unified TypeScript stack, and the later additions).
3. **[references/content-strategy-framework.md](./references/content-strategy-framework.md)** — what the analysis looks for and why it predicts performance. v1 extracts only a lean core; the rest is the documented backlog.
4. **[docs/schema.md](./docs/schema.md)** — the normalized data model (the three tables + JSON shapes + the derived-metric null rule).
5. **[docs/build-spec.md](./docs/build-spec.md)** — the operational details a build needs: cost guardrails, prompt-hash versioning, the run API contract, the Definition of Done + smoke test, and required env keys.

## Build path (v1, linear — each step depends on the prior)

1. **Scaffold** — Next.js app + TypeScript, `package.json`, the `config/*` files, the two `prompts/*` files, `.gitignore` (ignore `data/`), and `.env` from `.env.example`. Mark `better-sqlite3` as a server external package in `next.config.ts`.
2. **`lib/core/store.ts`** — create the three tables and the upsert/query helpers ([schema.md](./docs/schema.md)).
3. **`lib/core/scrape.ts`** — Apify reels + profile + comments → upsert `creators`, append `creator_stats`, upsert `reels` metrics.
4. **`lib/core/metrics.ts`** — compute the derived fields (performance / engagement / virality / outlier) per the null rule.
5. **`lib/core/analyze.ts`** — Gemini transcribe + analyze, newest-first and capped, with prompt-hash provenance; download → analyze → delete; keep the thumbnail.
6. **`lib/core/pipeline.ts`** — orchestrate `scrape` / `analyze` / `refresh` / `full` (the shared core all entry points call).
7. **`cli/index.ts` + the thin skill** — the terminal + conversational entry points.
8. **`app/api/content-pipeline/runs/route.ts`** — the run API contract (POST + GET status), calling `lib/core`.
9. **`app/` dashboard** — sort by performance / category / virality, thumbnails, original-Reel links, and a "Run pipeline" button that polls the run API.
10. **Verify** against the Definition of Done smoke test in [build-spec.md](./docs/build-spec.md).

## Required keys

`APIFY_TOKEN` (Instagram scraping) and `GEMINI_API_KEY` (transcription + analysis) are required; `ANTHROPIC_API_KEY` (Claude — FAQ clustering + draft generation) is optional and degrades to a safe no-op when absent. See [.env.example](./.env.example).

## License

[MIT](./LICENSE).
