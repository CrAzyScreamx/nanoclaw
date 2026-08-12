---
name: elevenlabs-calls
description: Place outbound phone calls through ElevenLabs voice agents, and report back what was said. Use when asked to call or phone someone, ring a business, confirm or book something by phone, chase an order or a delivery, or to report on a call that has already happened.
---

# Phone calls

You may have tools named `mcp__elevenlabs__*`. They dial a real phone number and put an
ElevenLabs voice agent — a persona the operator built — on the line. The persona holds the
conversation; you choose who to call, which persona speaks, and what it needs to know.

**If you have no `mcp__elevenlabs__*` tools, this isn't set up for you.** Say so plainly — "I
can't place calls" — and stop. Enabling it is an operator action on the host
(`/add-elevenlabs-calls`), not something you can do from here.

**Read the tool descriptions** for which agents you can call, which number each one dials from,
and which dynamic variables it needs. They carry the list for this group; this file carries the
judgement.

## Confirm before every dial

A call rings a real phone, in someone's real day, and nothing here can hang it up once it has
started. Before every dial, say back:

- **who** you are calling and **on which number**,
- **which persona** will speak,
- **which dynamic variables** you are filling in, and with what values.

Then wait for an explicit yes. Not an inference from an earlier "go ahead", not a yes to a
different question — a yes to those details.

**One approval covers one call.** Not the next one, not the rest of the conversation, and not a
second attempt at the same one. If anything at all changes — a corrected number, a different
persona, a retry after nobody answered — ask again, showing the new details.

If the request leaves who to call or what to say ambiguous, ask before dialing rather than
filling in the most plausible value. A wrong guess here reaches a stranger's phone.

## Never re-dial because a poll was slow

`start_call` returns as soon as ElevenLabs accepts the call. The result comes back later,
through a scheduled task. Quiet in between means the call is still running — not that anything
failed.

- **Never call `start_call` twice for one request.** That rings the person twice, with the same
  persona opening the same conversation, and they have no way to tell which is real.
- **Never create a second follow-up task for the same call.** One call, one series.
- If someone asks whether it went through, read the status with `get_call` and answer from it.
  Don't infer an outcome from the dial having been accepted.

## Stay inside the persona and the allowlist

Only the agents in the tool descriptions can be dialed, and each one is bound to the number it
calls from. If none of them fits what is being asked — a persona written for delivery
follow-ups being pointed at a doctor's office — say that instead of repurposing one. The person
who picks up hears whatever script that persona was built for, and cannot be corrected
afterwards.

## Where the detail lives

| Read this | When |
|---|---|
| `references/placing-a-call.md` | Before dialing: picking the persona, filling the variables, the confirmation script, and the follow-up command `start_call` hands back. |
| `references/call-results.md` | Waking from an `el-call-…` task: what each status means, how to summarize, who to send it to, and how to close the series. |
| `references/call-history.md` | Asked about a past call, or the variables in a tool description look out of date. |
