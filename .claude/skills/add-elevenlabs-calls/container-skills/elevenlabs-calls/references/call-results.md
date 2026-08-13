# When a call comes back

Read this when a task named `el-call-…` has woken you.

## What you already have

The task carries a **Script output:** block holding the call's final state — status, duration,
the summary and analysis ElevenLabs produced, and the transcript. That is the whole result.

The poll script only wakes you when there is something to report, so a wake means the call has
reached a terminal state or run past its deadline. Read the block and answer from it; calling
`get_call` again to fetch what you were just handed wastes a turn and can return the same thing.

## What the status means

| `status` | What happened |
|---|---|
| `done` | The call connected and completed. The transcript is final. |
| `failed` | It never connected, or it dropped. There may be no transcript at all. |
| `processing` | The call ended and ElevenLabs is still assembling the transcript and analysis. |
| `in-progress` | Someone is on the line right now. |
| `initiated` | Accepted, not yet ringing through. |

A `timed_out` flag means the deadline passed without a terminal state. Say that plainly — "the
call is still open after 30 minutes and I stopped waiting" — rather than reporting it as
finished or as failed.

If you were woken on `initiated`, `in-progress` or `processing`, do not summarize a partial
call and do not start a new one. Say the call is still running and leave the series alone; the
next fire brings the result.

## Summarizing

Lead with the outcome, then what was actually said, then anything that needs a person.

- **Outcome first.** "They confirmed the appointment for Thursday at 10" or "Nobody answered —
  it went to voicemail" is the first line. Not "the call completed successfully".
- **Quote exactly** where a commitment, a number, a price or a time was given. Everything else
  can be your own words.
- **Don't paste the raw transcript** unless someone asks for it. Offer it instead.
- **Say when nothing was achieved.** Voicemail, a refusal, a wrong number, or a person who hung
  up are all real results and each needs a different next step from the human.
- **Never fill a gap.** If the transcript doesn't say whether something was agreed, the answer
  is that it doesn't say — not the likeliest reading of it.

Do not decide on a follow-up call yourself. If one is obviously needed, propose it and wait;
that is a new dial and needs its own confirmation.

## Getting the summary out

Use `send_message` with an explicit `to`, taking the destination from the task prompt (that is
where `report_to` landed):

```
send_message({ to: "<destination from the prompt>", message: "<the summary>" })
```

**`ask_user_question` reaches nobody in a task run.** A task session has no routing for it, so
the question card is dropped and the tool sits there until it times out. `send_message({to})` is
the only way out of this turn — so anything you would have asked has to be phrased as part of
the message you send.

## Close the series

The task polls every two minutes until it is cancelled. Once you have sent the summary, end it:

```
ncl tasks list
ncl tasks cancel --id <the el-call-… series id for this conversation>
```

`ncl tasks list` is auto-scoped to this group inside a container. The series id starts with
`el-call-` and carries as much of the conversation id as fits before a short random suffix, so
match on the leading characters of this call's id and cancel that series only — cancelling the
wrong one leaves a different, live call unreported. If two series look alike, check the run
history rather than guessing.

The deadline in the poll script is the backstop if this doesn't happen, but it is a backstop:
until then the series keeps firing and keeps spawning this container.
