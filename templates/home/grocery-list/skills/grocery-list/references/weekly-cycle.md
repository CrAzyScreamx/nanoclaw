# The weekly cycle

The list runs in weeks. A week opens on a configured day and hour — Wednesday at
10:00 unless setup chose otherwise, in the container's own timezone. `config
--json` names the current setting (`data.weekStart`, plus a readable
`weekStartLabel`). The boundary day *before* the boundary hour is still the
**old** week.

Every item belongs to the week it was added in. Outside the weekly tasks the
rollover is automatic — you never trigger it by hand. `rotate` is those tasks'
verb and nothing else's.

## The rollover is lazy, and that is load-bearing

**Almost every verb rolls the week over as a side effect** once the boundary has
passed — `list` included. The exceptions are `pre-rotate`, `unmark`, and the
`--id` forms of `mark-bought` and `remove`, which never resolve a week at all.

This is why the rollover review has to ask *before* anything else runs: one stray
`list` at the boundary hour closes the week the question was about. It is also
why `pre-rotate` exists — it is the only read in the whole CLI that does not trip
the rollover.

## Carry-over is opt-in, and only the user decides it

A rollover on its own starts the new week empty. Unbought items reappear only
because the user asked for them at the rollover prompt — never on your own
initiative, and never because it seems helpful. **Silence is not consent to carry
items forward.**

Carried items are **copies**. The originals stay `pending` in the closed week,
because they genuinely were not bought that week and the history has to keep
saying so. If someone asks about an item from a previous week, use `list --week
last` or `report --week last` — nothing is ever lost, it simply is not on the
current list.

`list` is always scoped to one week and defaults to the current one. Never
present a past week's items as if they were still on the list.

## The weekly tasks

Three scheduled tasks drive the week, and setup decides which of them are
running:

| When | What it does |
|---|---|
| The evening before the boundary | A heads-up on the closing week: what was bought, what was not, one last chance to correct |
| At the boundary | Asks what to carry over, waits for the answer, then rotates |
| That evening | The fallback, if nobody answered: rotates and carries **nothing** |

Each arrives with its full procedure in its own message; follow what the task
says, not a memory of what these tasks usually do.

**Never run `pre-rotate` or `rotate` outside these tasks**, and never send a
rotation, reminder, or summary message on your own initiative at any other time.

**An unanswered rollover question is not a stuck week.** The evening fallback
handles it and carries nothing. Do not chase the user for a reply.

## What a user asks for in between

- "What did we not buy last week?" → `report --week last` or `list --week last`.
  Show those by name; do not number them (`references/positions-and-ids.md`).
- "Put that back on the list" → an ordinary `add`, in the current week. Never
  reach for `rotate` to move an item.
- "How many weeks have we been doing this?" → `weeks`.
