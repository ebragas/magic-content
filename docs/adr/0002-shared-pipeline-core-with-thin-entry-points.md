# Shared pipeline core invoked by CLI, skill, and dashboard

The scrape→analyze→refresh pipeline is a reusable TypeScript module (`lib/core` — importable functions like `scrape`, `analyze`, `refresh`, `pipeline`) with **no business logic in the entry points**. Three thin entry points call it: a TypeScript CLI (the primary engine), a thin Claude skill wrapper (over the CLI), and the Next.js app's `/content-pipeline/runs` route handler (the dashboard's "Run pipeline" button).

Because the whole stack is TypeScript (ADR-0005), the dashboard and the CLI import the **same function** — there is no cross-language boundary and no separate API service. The route handler calls `pipeline()` directly, exactly as the CLI does.

We chose a shared core because the user wants to trigger the same process from all three places; putting logic in the CLI's argument handling or in a `SKILL.md` would force the others to duplicate it. One implementation, one source of truth for behavior.

Consequence: `lib/core` must stay free of UI/CLI/HTTP concerns (no `process.argv`, no `Request`/`Response`) so all three callers can use it. It owns SQLite store access (`better-sqlite3`) and is therefore server-side only.
