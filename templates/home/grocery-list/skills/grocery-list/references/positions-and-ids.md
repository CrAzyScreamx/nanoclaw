# Positions and ids — the one rule, stated once

**Every number the group ever sees is a position (`n`), never a row id.** This
is the rule the rest of this skill points back to; wherever a number appears
elsewhere, this is what it means.

- **A number the user quotes back is a position. Pass it as `--n`.**
  "I bought 2 and 3", "delete 5":

  ```
  bun /workspace/agent/plugins/grocery-list/tools/grocery.ts mark-bought --n 2,3
  bun /workspace/agent/plugins/grocery-list/tools/grocery.ts remove --n 5
  ```

  Never hand it to `--id`. The two number spaces do not line up: positions
  restart at 1 every week, row ids never repeat, so position 2 is usually some
  three-digit id — and `--id 2` would silently act on an unrelated item or on
  nothing at all. Do not do the mapping by hand either:
  `--n` resolves against the same ordering the message was rendered from, and
  against a snapshot taken before any write.
- **`--id` is only for ids you read yourself**, out of `message --json` or
  `find`. Exactly one flow does that — the receipt path
  (`references/receipts.md`).
- **The commands hand you positions where you need them.** `message --json`,
  `pre-rotate --json` and `report --json` put an `n` on each pending item, and
  `rotate` takes those back as `--carry-n` / `--bought-n`.

Two rules follow, and the weekly tasks spell out both:

- **Number pending items, never bought ones.** `mark-bought` only ever acts on
  something still pending, so a numbered bought list is a second number space
  in the same message, and "number 3" stops having one answer. `report --json`
  therefore gives `bought` no `n` at all — show those by name.
- **Do not number history.** Once a week has closed, its leftovers are not on
  any list, and a number beside them invites an answer aimed at a list that no
  longer exists. Same for items you just carried: they live in the *new* week
  now, numbered from 1 there, and `message` is what knows those numbers.

## Why the receipt path is the exception

Positions resolve against the list *as it is when the command runs*. The receipt
flow deliberately waits for the group to confirm a reading, so anything added or
removed between your question and their answer shifts every `n` under it. Ids do
not move. That is the whole reason `--id` exists, and it is why loosening this
rule does not fail loudly — it marks or deletes the wrong item and says nothing.

## Two numbers that are not positions either

- **A product id** — the number in `add --confirm <token> --same-as
  <product-id>`, and the only place a number means a *product* rather than a
  row. It comes out of the candidate list `add` printed, never from the group.
- **A confirmation token** — an opaque string, never shown to the group, never
  confused with a number of any kind.
