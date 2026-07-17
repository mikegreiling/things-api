# The Things data model

Entities and relationships, as exposed by the `things` CLI.

## Entities

| Entity | Container | Can contain | Dates | Tags |
| --- | --- | --- | --- | --- |
| To-do | area, project, heading, or NONE (standalone) | checklist items | when, deadline, reminder | own + inherited |
| Checklist item | its to-do | — | — | — |
| Heading | its project | to-dos | — | none (inheritance passes through) |
| Project | area or standalone | headings, to-dos | when, deadline | own + inherited from area |
| Area | top level | projects, loose to-dos | — | own |
| Tag | tag hierarchy (may nest) | child tags | — | — |

## Rules

- A to-do has at most ONE container, and may have none — standalone to-dos (no project, no area) are normal and appear at the top level of Anytime/Someday/Upcoming. Moving changes the container; completing or trashing does not.
- The **Inbox is a state, not a container**: "in the Inbox" means untriaged — no container AND no schedule. Filing or scheduling an inbox to-do moves it out (filing promotes it to Anytime); moving a to-do TO the Inbox clears both its container and its schedule.
- A heading is a section label inside one project — not a task. It cannot be scheduled, tagged, or completed; deleting/archiving it affects only the label, per the operation's contract.
- Tag inheritance flows downward: area → project → (through heading) → to-do. A to-do's *effective* tags = own tags ∪ project tags ∪ area tags. List output distinguishes own vs inherited tags.
- **Status**: open → completed or canceled (both land in the Logbook) or trashed (Trash; restorable until emptied). Reopen brings a logged item back.
- **when** (`today | evening | anytime | someday | YYYY-MM-DD`) controls which view an item appears in; **deadline** is an independent due date shown alongside the item; **reminder** is a time-of-day alert attached to a dated when.
- "Overdue" = open with a deadline strictly before today (a deadline of today is "due", not overdue).

See [reads.md](reads.md) for how views map onto these rules and [writes.md](writes.md) for changing them.
