# Triage Labels

The skills speak in terms of five canonical triage roles. In this repo they map **1:1** to Linear labels that already exist on the **Main** team — apply the label of the same name, don't create new ones.

| Canonical role    | Linear label      | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

Apply labels via `save_issue` (Linear MCP). Note the relationship to Linear's native **Triage** workflow status: an incoming issue sits in the **Triage** *status* carrying the `needs-triage` *label*; resolving triage swaps the label (and usually the status) to the appropriate next role. `wontfix` pairs with the **Canceled** status.

Edit the right-hand column if the label vocabulary ever changes.
