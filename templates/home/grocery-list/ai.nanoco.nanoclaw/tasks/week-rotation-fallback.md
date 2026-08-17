---
schedule: "0 22 * * 3"
---

The fallback for the week rollover — it runs only in case nobody answered the question the
rollover task asked this morning.

**Run:**

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts rotate --json
```

No `--carry` and no `--carry-n`. Nobody asked for anything to be carried over, and **silence
is not consent** — the new list starts empty.

Every field named below lives under `data` in the `--json` envelope
(`{"ok":true,"data":…}`).

If `rotated` is `false`, the rollover has already been done today. Send no message. End
silently.

If `rotated` is `true`, send exactly one message to the group with `send_message` — this is a
scheduled run, so that is the only way a message from it reaches anyone — in the configured
language: a new week has started, a short summary from `closed_week`, and what was not
bought. Say that the items were not carried over because there was no answer, and that
anything still wanted can simply be added again.

**Show the items in `closed_week.pending` by name only, with no numbers.** They are history
now — they are not on any list, and the new list is empty. A number beside them would only
invite an answer aimed at a list that no longer exists. Anyone who wants something back will
ask for it by name, and then you add it normally with `add`.

One message only.
