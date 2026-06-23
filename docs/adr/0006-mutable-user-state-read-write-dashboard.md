# Mutable user state — the dashboard becomes read-write

Until now the system was strictly one-way: the pipeline writes the Content Store and the dashboard only reads it (the sole exception being the pipeline-run trigger). The Editable Draft feature reverses this — Drafts, Favorite, and Archive are **user-authored, mutable state** persisted back to the store from the dashboard, introducing the first real mutation API surface (`PUT`/`PATCH`/`POST` on `/api/reels/{shortcode}`).

## Consequences

- A new `drafts` table (1:1 with `reels`) plus `is_favorite` / `is_archived` columns hold state that no pipeline run produces and none may clobber. This is categorically different from analysis (immutable, machine-derived) and metrics (refreshed, machine-derived).
- The `Store` interface gains write methods beyond the pipeline's needs (draft save, flag toggles), and the dashboard gains client-side optimistic mutation.
- The strict read/write separation that justified loading the whole store once server-side (ADR-0001 / the dashboard's load-once shell) still holds for *machine* data, but user edits now flow back through dedicated routes rather than a pipeline run.

We accepted this because the Draft is the feature's whole point: an AI-seeded artifact the user edits, saves, and returns to. Keeping it session-local (as the original "your version" scaffold was) or in a separate system would sever it from the Reel it's derived from.
