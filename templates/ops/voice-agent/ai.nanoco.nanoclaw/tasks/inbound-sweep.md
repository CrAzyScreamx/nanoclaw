---
schedule: "*/10 * * * *"
script: |
  bun /workspace/agent/plugins/voice-agent/tools/sweep.ts inbound
---

# Inbound sweep

New **inbound** calls finished since the last sweep are in the **Script output:**
block above. Each entry carries `id`, `direction`, `status`, `startedAt`,
`durationSec`, `fromNumber`, `toNumber`, `personaName`, `title`, `summary`,
`successful` and `collected`. Summaries only — no transcripts, and at most ~15
calls per fire; if a `truncated` count is present, say so, because more calls
came in than this run reports.

If the block carries `complete: false`, this fire could not read the whole
backlog: older calls exist that it never saw, so `truncated` is a floor, not a
count. Say "at least N more" rather than a number.

A call appears here once it is finished, which means `status: done` **or**
`status: failed`. A separate `abandoned` list may also be present: those are
calls that never reached either state within six hours, so the sweep stopped
waiting for them and is telling you once. Mention them in a single line at the
end — id and nothing more unless `calls.ts show <id>` tells you something worth
passing on — and do not treat them as failed calls. The block can carry
`abandoned` with no `calls` at all; that is a valid, quiet fire.

Triage every call in the block:

1. **Who called and what they wanted** — the number, and the ask in one line
   from `title` / `summary`.
2. **Whether the persona resolved it** — read `successful` together with
   `summary`, not on its own. A call marked `success` whose summary says the
   caller was told to call back has not been resolved.
3. **What the collected data says** — anything in `collected` (name, order
   number, callback time, intent) is the part a human will act on. Quote the
   values exactly; do not paraphrase a number.
4. **Whether it needs a human** — an unresolved ask, an angry caller, a request
   the persona is not configured for, a very short call that ended before
   anything was said.

Then send **one** message with `send_message`, grouped by outcome:

- **Resolved** — one line each, briefest form.
- **Needs a human** — one line each with the number, what they wanted, and the
  suggested next step.
- **Failed or suspicious** — calls with `status: failed`, near-zero
  `durationSec`, or a summary that reads like the persona misfired. Say what you
  think went wrong.

Close with the counts and the window covered. If the block is empty, send
nothing.

To read a full transcript before deciding how to categorise a call:

```
bun /workspace/agent/plugins/voice-agent/tools/calls.ts show <id>
```

Constraints for this run — it is unattended and nobody is in the turn:

- Do **not** use `ask_user_question`. There is no one to answer it.
- Do **not** place a call, return a call, or hang one up. Propose the callback
  and let a human approve it in a real conversation.
- Do not change persona configuration or line assignments on the strength of one
  bad call. Report the pattern instead.
