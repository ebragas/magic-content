# Unified TypeScript stack — one language, no separate backend

The entire system is TypeScript: the pipeline core (`lib/core`), the CLI (`cli/`), and a Next.js app (`app/`) that serves both the dashboard UI and the `/content-pipeline/runs` API route handlers. SQLite is accessed via `better-sqlite3`, Apify via its JS client (`apify-client`), and Gemini via `@google/genai`. There is no Python and no separate API service (e.g. FastAPI).

Earlier in this design session we considered a polyglot split — reuse the Python source (`content-strategist`) behind FastAPI with a Next.js frontend — to get UI polish. We reversed it: since the dashboard is already Next.js and both external dependencies have first-class JS SDKs, unifying on TypeScript removes the second toolchain and the cross-language boundary entirely. The "dashboard button runs the same process" requirement (ADR-0002) becomes a direct function call instead of an HTTP hop to another runtime.

Trade-off: we port the source's logic (engagement scoring, Apify input shapes, the Gemini upload→poll→delete flow, the undercount-retry heuristic) to TypeScript rather than reusing the proven Python scripts. The SDKs make this low-risk, and the source remains a reference.

Consequence: the SQLite store and all pipeline code are server-side only (Node runtime, not Edge); `better-sqlite3` is marked as a server external package in `next.config`. The app is meant to run locally (`next dev` / `next start`) — a long-running process so background runs survive — not on a serverless host that would kill in-flight pipeline runs.
