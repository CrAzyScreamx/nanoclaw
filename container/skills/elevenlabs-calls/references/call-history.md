# Past calls and the agent directory

Read this when someone asks about a call that already happened, or when the agent list in the
tool descriptions looks out of date. Nothing here dials anything.

## Past calls — `list_conversations`

Lists calls made by one of this group's agents, newest first. Take `agent` from the tool
description, and ask for summaries when the question is about *what happened* rather than *when*.

Use it for:

- "Did we ever call them back?" — find the conversation, then answer from its summary.
- "What did they say last time?" — the summary usually answers it; `get_call` on that
  conversation id gives the full transcript when it doesn't.
- "How many times have we called this week?" — count, and say the window you counted over.

Two things to be careful about:

- **It only sees calls placed through ElevenLabs**, by agents this group is allowed to use. A
  call somebody made from their own phone isn't in here, and neither is one placed by another
  agent group. "There's no record of a call" is the honest phrasing; "we never called" is not.
- **Match on more than a name.** Two conversations with the same person on the same day are
  ordinary. Use the timestamp when you report which one you mean.

## The agent directory — `list_agents`

Re-reads this group's allowlisted agents and their **current** dynamic variables from
ElevenLabs.

The variables in the `start_call` description were captured when the operator ran
`/add-elevenlabs-calls`. If someone has edited a persona's prompt since then, it may now expect
a variable the description doesn't mention. `list_agents` is what settles that — and it is worth
running before dialing whenever:

- someone refers to a variable you can't find in the description,
- a previous call went out with an obviously empty-sounding opening line,
- or the operator says they changed something in ElevenLabs.

If `list_agents` shows variables the `start_call` description doesn't, say so — the persona has
moved on and the operator should re-run `/add-elevenlabs-calls` to refresh the snapshot. Include
the extra values in the dial you were about to make; if `start_call` rejects them, report that
error rather than dialing without them, because a persona missing a variable it now needs opens
the call with a gap in its first sentence.

Neither of these tools places a call or changes anything in ElevenLabs. They are safe to run
without asking.
