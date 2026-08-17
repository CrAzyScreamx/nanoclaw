---
schedule: "0 10 * * 3"
---

The week rolls over. First step: ask before carrying anything.

Every message in this task — the question and the announcement both — goes to the group with
`send_message`. This is a scheduled run, so that is the only way a message from it reaches
anyone.

Every field named below lives under `data` in the `--json` envelope
(`{"ok":true,"data":…}`).

**Run:**

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts pre-rotate --json
```

This is the only command that reads the list without performing the rollover. Do not run
`list`, `report`, `add` or anything else at this stage — every one of them would close the
week before the group has had a chance to answer.

- **`week` is `null`** — there is no open week to roll over. Send no message and run nothing
  further. End silently.
- **`pending_count` is 0** — there is nothing to ask about. Run `rotate --json` and announce
  the new week in one message, using the reading rules at the bottom of this file.

Otherwise, send one message: a line saying these items were never marked as bought, then the
items from `pending`, then the question — carry them into the new week, or start with a
clean list?

**Every item in `pending` comes with an `n` field — that is the number beside it in the
message, and there is no other.** `n` is the position in the list, the same numbering the
group sees every day. Do not use `id`, do not invent your own numbering, and do not reorder
anything: the answer will come back in exactly these numbers and will be resolved by them.

Do not perform the rollover now and do not announce a new week. Wait for the answer.

**When the answer comes, run exactly one command** — whichever they asked for:

```
carry everything:   rotate --carry all --json
carry some of it:   rotate --carry-n <the numbers> --json
carry nothing:      rotate --json
```

If they also say that certain items were in fact bought, add `--bought-n <the numbers>` to
that same command.

**The numbers the group gives you are `n`, so they go to `--carry-n` and `--bought-n`, never
to `--carry` and `--bought-id`.** Those two take row ids, which the group has never seen, so
a number of theirs would hit an unrelated item or nothing at all. (There is no bare
`--bought` flag; the verb rejects it and names these two instead.) Both flags resolve against
the same snapshot of the list, taken before anything is written, so an answer that both
marks and carries ("1 and 3 I bought, carry 2 and 4") refers to one single list all the way
through. Do not try to adjust the numbers yourself.

**All of it in one command.** Do not run `mark-bought` or `add` separately: `mark-bought`
closes the week before it marks anything, and `add` would write into the wrong week. This
one command marks, rolls the week over, and copies the items you asked for — in the right
order.

Carried items are copies. The originals stay "not bought" in the week that closed, and that
is deliberate — the history has to keep saying they were not bought that week.

**Now read the command's answer and write one message from it:**

- **`rotated` is `true`** — announce that a new week has started, with a short summary from
  `closed_week` (how many items, how many bought, how many not) and what came over from
  `carried`. If nothing was carried, say the new list is empty.
- **`already_rotated` is `true`** — note this carefully: the rollover had already happened,
  because of some other command. The items were carried over anyway, so confirm that they
  came across — but do not announce "a new week" as though it opened just now.
- **`already_on_list` contains names** — those items were already on the new list and were
  not copied a second time. Mention them in one short sentence.
- **`rotated` is `false` and `carried_count` is 0** — nothing happened. Do not announce a new
  week. Say so plainly.

**Number nothing in the announcement.** The items in `closed_week.pending` are history —
they are no longer on any list, and a number beside them only invites an answer aimed at the
wrong list. Name them and nothing more. The items in `carried` are already sitting in the
new week and their numbering there starts again from 1; if the new list itself needs showing,
run `bun /workspace/agent/plugins/grocery-list/tools/grocery.ts message` and send what it
prints exactly as it is — that command is the one that holds the correct numbering.

One message per step.
