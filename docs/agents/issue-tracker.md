# Issue tracker: Linear

Issues and PRDs for this repo live in **Linear**, managed via the **Linear MCP** tools (`mcp__claude_ai_Linear__*`). There is no `gh`/`glab` CLI workflow and no local `.scratch/` tracker.

## Coordinates

| Field | Value |
| --- | --- |
| Team | **Main** (`key: MAIN`, id `f89d7f33-57e9-4f77-a245-57b198d3a0a2`) |
| Project | **Content Engine** (id `8325cf81-498a-41b0-9240-58227a0b96cb`) |
| Workspace | `linear.app/eric-bragas` |

Always scope new issues to the **Content Engine** project on the **Main** team unless told otherwise.

## Conventions

- **Create an issue**: `save_issue` with `team: "Main"`, `project: "Content Engine"`, a clear `title`, and a markdown `description`. New incoming issues should start in the **Triage** status (`needs-triage` label) unless the skill already knows the issue is fully specified.
- **Fetch a ticket**: `get_issue` by identifier (e.g. `MAIN-123`). The user will normally pass the identifier or a Linear URL.
- **List issues**: `list_issues` filtered by `project: "Content Engine"` plus `label` and/or `state` as needed.
- **Comment on an issue**: `save_comment` (read existing discussion with `list_comments`).
- **Apply / remove labels & change state**: `save_issue` with the updated `labels` / `state`.
- **"Won't fix"**: apply the `wontfix` label and move the issue to the **Canceled** status.

## Workflow states (Main team)

`Triage → Backlog → Todo → In Progress → In Review → Done`, plus `Canceled` and `Duplicate`. The native **Triage** status is the landing zone for newly-created, not-yet-evaluated issues; the canonical triage *labels* (see `triage-labels.md`) carry the finer-grained routing on top of these states.

## PRs

Not applicable — Linear is the request surface, not pull requests.
