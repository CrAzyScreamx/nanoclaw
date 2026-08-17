# Reference: working the results

What to do with calls after they happen — inbound triage and outbound follow-up.

## How calls reach you

Two ways.

**1. A sweep wakes you.** `inbound-sweep` and `outbound-sweep` are scheduled
tasks gated by `tools/sweep.ts`. The gate lists conversations newer than a
watermark, keeps the finished ones in its direction, advances the watermark no
further than the oldest call still running, and prints one JSON object. When
there is something new, the calls arrive in your prompt as a **`Script output:`**
block:

```json
{"wakeAgent": true, "direction": "inbound", "truncated": 0, "calls": [ … ]}
```

- **Summaries only, no transcripts.** The gate is capped at 30 seconds and 1 MB
  of output, so it sends about **15 calls per fire** and reports the rest as a
  `truncated` count rather than dropping them silently.
- `truncated > 0` means more calls are waiting. They are **not** lost: the sweep
  reads the **oldest** end of the window, advances the watermark only to the last
  call it actually delivered, and skips ids it has already reported — so the next
  fire brings the rest. Say so rather than implying calls were missed.
- **Finished means `done` or `failed`.** A call that failed is an outcome you
  have to hear about, so the sweep reports it like any other. A call still
  running is not reported yet, and it holds the watermark where it is until it
  ends — which is why a 40-minute call reaches you at the fire after it ends
  rather than never.
- `abandoned: ["…"]` is the rare case: those calls never reached a finished
  state within six hours, so the sweep stopped waiting for them and told you
  once. They are not failures and not summaries — run `calls.ts show <id>` if
  you want to know what became of them, and mention them only if they matter.
- `complete: false` means the fire could not read the whole backlog. `truncated`
  is then a lower bound, not a count — say "at least N more".
- `{"wakeAgent": false}` means nothing new; you never see it.

**2. You ask.** `calls.ts list` with any of `--live`, `--direction`, `--since`,
`--limit`, `--persona`.

## What you already have, without a detail fetch

Each call in a sweep payload, and each row from `calls.ts list`, carries enough
to triage without another request:

| Field | Use it for |
|---|---|
| `direction` | inbound vs outbound handling |
| `status` | finished, still running, failed |
| `successful` | the provider's own success / failure / unknown verdict |
| `summary` | what the call was about, in a sentence or two |
| `title` | a short label, good for grouping |
| `collected` | structured data the persona was told to collect |
| `startedAt`, `durationSec`, `fromNumber`, `toNumber` | who, when, how long |

**Do not pull a transcript you do not need.** One per call is slow and mostly
redundant with the summary.

## When to pull the full transcript

```bash
bun /workspace/agent/plugins/voice-agent/tools/calls.ts show <id> --transcript
```

Worth it when:

- the summary and the collected data disagree, or the collected data is empty
  when it should not be,
- the outcome is `failure` and nobody knows why,
- the user asks what was actually said, or asks for a quote,
- a complaint, a commitment, or anything that may need to be repeated verbatim.

The transcript is turn-by-turn: `role` (agent / user), `time_in_call_secs`, and
the text. `show` also prints the carrier-side **call sid**, which is what every
hang-up route needs.

## Reporting

Group before you list. Three inbound calls about the same broken thing are one
finding, not three lines. A useful report:

1. **The headline** — how many calls, over what window, and the one thing that
   matters most.
2. **Groups** — by title or topic, with the count and one line of what each was
   about.
3. **Anything needing a human** — a promise made, a complaint, a failure, a
   number that should be called back.
4. **The ids**, so the user can ask for a transcript.

Keep it short. Nobody wants a per-call play-by-play of a quiet morning.

## In a task run

- **Report with `send_message`.** Never `ask_user_question` — a task run has no
  human in the turn and the question reaches nobody.
- **Never place a call from a task run.** Propose it; the dial happens in a real
  conversation with a real yes. See `placing-calls.md`.
- If nothing needs a human, say nothing rather than sending a "nothing happened"
  message on a schedule.

## Where state lives

Everything is under `/workspace/agent/voice-line/` — never inside the plugin
directory, which is mounted read-only:

| Path | What |
|---|---|
| `config.json` | provider, lines and their carriers, carrier identifiers |
| `state.json` | sweep watermarks, one per direction, plus the ids each sweep has already delivered |
| `calls.jsonl` | append-only log of dials and hang-ups this agent performed, and of the calls each sweep reported |
| `campaigns/<id>.json` | one record per campaign |

None of these ever holds a key, a token, or a password.
