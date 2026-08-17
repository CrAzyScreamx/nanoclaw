---
schedule: "0 20 * * 2"
---

The evening before the week rolls over. The point: remind the group that a new week starts
tomorrow, show the full picture of the current week — what was bought and what was not — and
give one last chance to correct, mark and add.

Every field named below lives under `data` in the `--json` envelope
(`{"ok":true,"data":…}`).

**Step 1 — run:**

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts pre-rotate --json
```

This is the only command that reads the list without rolling the week over, which is why it
always goes first.

- **`week` is `null`** — there is no open week. Send no message at all. End silently.
- **`boundary_passed` is `true`** — this task ran late and the rollover has already
  happened. Send no message, and run nothing further. The rollover task is what handles the
  turn, and a reminder about "tomorrow" after tomorrow has arrived only confuses. End
  silently.

**Step 2 — only if `boundary_passed` is `false`, run:**

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts report --week current --json
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts config --json
```

The first gives this week's `bought` and `pending`. The second gives `weekStartLabel`, the
day and hour the week actually turns over, so the message names the real time rather than an
assumed one.

Do not run `rotate`, do not run `mark-bought`, and do not add anything on your own
initiative — this reminder does not change the list.

**Step 3 — send exactly one message to the group with `send_message`,** in the configured
language.

**The numbers in the message are the `n` field, never `id`.** Every item in `pending` comes
with an `n` — precisely the number it carries in the list the group sees every day. Use it
as it is. Do not invent your own numbering, do not use `id`, and do not number the items
that were bought: `bought` has no `n` on purpose, because `mark-bought` only acts on items
that are still unbought, and two numbering schemes in one message make "number 3"
impossible to resolve. Bought items are shown by name only, with no number.

If `total` is 0 the list is empty. One or two lines only: a new week starts tomorrow at the
week-start time, nothing was listed this week, there is nothing to check. No headings and no
empty lists.

Otherwise the message contains:

- A short opening: a new week starts tomorrow at the week-start time. Here is what happened
  this week.
- A summary line: how many items in total, how many bought, how many not.
- A "Bought:" section, then the items from `bought` — name and quantity, no numbers. If
  `bought` is empty, one line saying nothing has been marked bought yet, with no heading and
  no empty list.
- A "Not bought yet:" section, then the items from `pending`, each with its own `n`. If
  `pending` is empty, one line saying everything was bought.
- A closing ask for one last check, in two parts: if something was already bought and simply
  not marked, say so now and it will be marked; and if something is missing for this week,
  there is still time to add it. Then say that in the morning you will ask what to carry
  over, and that anything not explicitly asked for will not carry.

One message only.

If a user replies with corrections — something bought that was never marked, or an item that
is missing — that is an ordinary request like any other, and you may mark or add
accordingly. The restriction above is on your own initiative, not on what you were asked to
do.

**When they mark something by number, that number is a position in the list — not an id.**
Use `--n`:

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts mark-bought --n 3
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts mark-bought --n 2,5
```

Never pass a number the user quoted to `--id`. The two numbering schemes do not overlap, and
`--id 3` would mark a completely different item, or nothing at all.
