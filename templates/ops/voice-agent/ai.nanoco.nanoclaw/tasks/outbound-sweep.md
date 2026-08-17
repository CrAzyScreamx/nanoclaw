---
schedule: "7,22,37,52 * * * *"
script: |
  bun /workspace/agent/plugins/voice-agent/tools/sweep.ts outbound
---

# Outbound sweep

**Outbound** calls that finished since the last sweep are in the **Script
output:** block above. Each entry carries `id`, `direction`, `status`,
`startedAt`, `durationSec`, `fromNumber`, `toNumber`, `personaName`, `title`,
`summary`, `successful` and `collected`. Summaries only — no transcripts, and at
most ~15 calls per fire; if a `truncated` count is present, say so, because more
calls completed than this run reports.

If the block carries `complete: false`, this fire could not read the whole
backlog: older calls exist that it never saw, so `truncated` is a floor, not a
count. Say "at least N more" rather than a number.

Finished means `status: done` **or** `status: failed` — a dial that failed
arrives here, and this block is the only place it does, so never re-dial on the
strength of not having heard about one. A separate `abandoned` list may also be
present: those are calls that never reached either state within six hours, so
the sweep stopped waiting for them and is telling you once. Report them in one
line, treat them as unresolved rather than failed, and propose no retry on that
basis alone. The block can carry `abandoned` with no `calls` at all; that is a
valid fire.

This is the follow-up pass on dials that were already approved and placed. For
each call work out:

1. **Did it connect to a person** — a normal `durationSec` with a two-sided
   summary, versus a few seconds ending on an answering machine, versus
   `status: failed` (no answer, busy, bad number).
2. **What the callee actually said** — the substance from `summary`, in their
   terms, not the outcome you were hoping for.
3. **What was collected** — quote the values in `collected` exactly: the answer
   given, the time agreed, the number corrected, the opt-out stated.
4. **What happens next** — nothing, a human call-back, or a retry.

Send **one** message with `send_message`, grouped by outcome:

- **Connected and done** — reached the callee, nothing further needed.
- **Connected, needs a human** — reached the callee and something was asked,
  disputed or promised that a person should handle. Name it.
- **Voicemail or no answer** — short calls and unanswered dials, with the number
  and when it was tried.
- **Failed** — `status: failed` or an error, with what it looks like (invalid
  number, carrier rejection, persona misfire).

For anything worth trying again, propose the retry — the number, the persona,
and when — and stop there. Treat an opt-out or "do not call me" as final: say so
prominently and propose no retry.

To read a full transcript before deciding:

```
bun /workspace/agent/plugins/voice-agent/tools/calls.ts show <id>
```

Constraints for this run — it is unattended and nobody is in the turn:

- Do **not** use `ask_user_question`. There is no one to answer it.
- Do **not** place a call, re-dial, or submit a campaign. Every dial needs a
  fresh explicit yes from a human in a real conversation, and this run cannot
  get one.
- Report and propose. Change nothing about personas, lines or campaigns.
