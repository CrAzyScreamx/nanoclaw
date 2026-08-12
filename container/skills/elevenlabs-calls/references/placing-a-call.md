# Placing a call

Read this when you are about to dial. Five steps, in order; the confirmation is step 4 and
nothing before it touches a phone.

## 1. Pick the persona

The `start_call` description lists the agents this group can dial, the number each one calls
from, and the dynamic variables each one expects. Pick by what the call is *for*, not by which
name sounds closest.

If nothing fits, stop and say so. A persona is a script and a voice someone wrote for one
purpose; pointed at a different purpose it says the wrong things to a real person, confidently,
and you find out afterwards from the transcript.

If the descriptions look stale — a variable someone mentions isn't there, or an agent you were
told about is missing — `list_agents` re-reads them live. `references/call-history.md` covers
that.

## 2. Get the number right

`to_number` is E.164: a leading `+`, country code, no spaces, dashes or brackets. `+972521234567`,
`+14155550123`.

- **Never infer a country code.** A local-format number from a chat message is not enough on its
  own; ask which country it is if you don't already know from the conversation.
- **An extension is not part of the number.** If someone gives you `+1415...x204`, dial the
  main number and let the persona ask for the extension, or ask what to do.
- If the number arrived through a forwarded message, a screenshot, or a document, read it back
  digit by digit in the confirmation. Transcription errors in phone numbers are common and the
  cost is calling a stranger.

## 3. Fill the dynamic variables

Every variable the agent lists has to have a real value. They are substituted into the persona's
prompt and its opening line, so they are literally the first words the person hears.

- **Never pass a placeholder to satisfy the requirement** — not `customer`, not `N/A`, not
  `unknown`. If you don't have the value, ask for it before dialing.
- Use the value in the form a person says it: a first name, a date as words, an order number
  read as it is written.
- Values you invented — an estimated delivery date, a price nobody quoted — become claims the
  persona states as fact. Only pass what you were actually told.

`start_call` refuses before it dials if a required variable is missing, so an error here has
cost nothing. Fix the value and try again; don't work around the check by passing something
empty.

## 4. Confirm

Say it back in one short message and wait for a yes:

> I'm about to call **<who>** on **<+E.164>** using the **<persona>** agent.
> It will say: <name> = <value>, <name> = <value>.
> Go ahead?

Anything the person corrects means a new confirmation, not an adjusted dial. If they answer
something other than yes or no, treat it as no and ask again.

## 5. Dial, then hand the follow-up over

Call `start_call` with `agent`, `to_number`, and `dynamic_variables`. Pass `report_to` when the
result should go somewhere other than where the request came from, and `phone_number_id` only
when the persona has more than one number and you were told which to use.

It returns `{conversation_id, status, follow_up_command}`.

**Run `follow_up_command` exactly as returned, byte for byte, in Bash.** It is a complete
`ncl tasks create` line with the conversation id, the deadline and the report destination
already substituted. Do not retype it, do not "tidy" the prompt, do not shorten the id, and do
not build your own version of it — a task polling a conversation id that is off by a character
never finds the call, and the real call then reports to nobody.

Then tell the person the call has started and that you will come back with what was said. Do
not poll it yourself, and do not wait in this turn: the task wakes you when there is something
to report.

## When `start_call` returns an error

Report it as it came back and stop.

- **Agent not allowlisted** — that persona isn't enabled for this group. Say so; don't
  substitute a different one.
- **Missing or unknown variables** — the error names them. Get the values, confirm again, redial.
- **The number was rejected** — the format is wrong or the persona's number can't reach that
  destination. Show the number you tried, so the mistake is visible.

None of these is a reason to try a different agent, a different number, or the same call again
without a fresh confirmation.
