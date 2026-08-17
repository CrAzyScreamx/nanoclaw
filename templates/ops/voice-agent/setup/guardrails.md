# Setup 6 — guardrails: the credit cap, the dial rule and the sweep cadence

Two settings that cost real money if they are left alone, and one limitation to
state plainly rather than configure. Neither setting is a default the template
can pick for the operator: one is a hard spend ceiling, the other is a bill.

## 1. The credit cap on the key

Set at key-creation time, back in `elevenlabs.md` step 1: the Create API Key
form carries a per-key **Usage Limits (Credits)** cap. Give it one.

It is the only ceiling here that ElevenLabs itself enforces, and it is the only
one that exists at all — nothing host-side stops a plain HTTPS call made from
inside a container (§2). A capped key stops being able to spend when it hits the
number, whatever the agent, the persona or the host is doing.

Pick the number as a loss the operator would shrug at for a month, not as a
forecast of usage. It is raised in the dashboard in seconds if it turns out to
be too tight, and rotating the key is not required to change it.

If the key already exists uncapped, this is still worth doing now rather than
after the first surprising bill.

## 2. The dial rule is a default, not a control

The persona's "confirm before every dial" rule is a **strong default, not
enforcement**. NanoClaw's guard seam does not see a plain HTTPS call made from
inside a container, so a model that talks itself past the rule is not stopped by
it. Say that plainly rather than selling the behavioural rule as a control.

There is nothing to configure here, and that is the point: on a line that calls
people who did not ask to be called, the capped key in §1 is the whole brake.
Set it low.

## 3. The two sweeps

The template ships two scheduled tasks, both **paused**, because stamping never
starts background work without consent:

| Task | Default schedule | What it does |
|---|---|---|
| `inbound-sweep` | `*/10 * * * *` | polls for finished **inbound** calls, triages them, reports in one message |
| `outbound-sweep` | `7,22,37,52 * * * *` | polls for finished **outbound** calls and proposes follow-ups |

```bash
ncl tasks list --group <group-id> --status paused
ncl tasks resume --id <task-id>
```

**Cadence is a bill, not a knob.** Every fire spawns the group's container for a
few seconds if it is idle. `*/10 * * * *` is roughly **144 spawns a day** on a
line where nobody called. Put the trade to the operator in those terms:

- widen the cron — `*/30 * * * *` halves it again;
- restrict to business hours — `*/15 9-18 * * 1-5` is ~200 fires a week instead
  of ~4,000;
- **outbound only? leave `inbound-sweep` paused entirely.** This is the most
  common right answer and the easiest to forget.

Retime with `ncl tasks update --id <task-id> --recurrence "<cron>"`.

**Keep the two schedules off each other's minutes.** The outbound default is
deliberately off the ten-minute grid: both sweeps read-modify-write the same
`state.json`, so two fires landing on the same second can lose each other's
record of what was already reported — which surfaces as a call reported twice.
If they retune one, check it against the other.

Both tasks carry a `script:` gate, and that is not optional — ungated tasks are
capped at 4 fires per 24h while script-gated ones may run often. The gate is
`sweep.ts`, whose last stdout line is a single JSON object with a boolean
`wakeAgent`: on `false` nothing spawns a turn, on `true` the call summaries are
rendered into the agent's prompt. If a retimed task loses its script, it will
quietly stop firing at its schedule; do not drop `--script` when updating one.
