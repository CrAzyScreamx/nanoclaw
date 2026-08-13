---
name: homeassistant
description: Operate things in the house through Home Assistant — the robot vacuum, the car, and the printer. Use when asked to clean a room, vacuum somewhere, stop or find the vacuum, or to check on it; for the car, to turn the AC on or off, lock or unlock it, or report battery, range, charge state or location; and for the printer, to report ink or toner levels, whether it is online, or why it stopped.
---

# Home Assistant

You may have tools named `mcp__homeassistant__*`. They talk to the house: a robot vacuum, a car,
a printer, or some combination. Everything you can do is one of those tools — there is no
configuration to read and no endpoint to construct.

**If you have no `mcp__homeassistant__*` tools, this isn't set up for you.** Say so plainly —
"Home Assistant isn't connected for me" — and stop. Enabling it is an operator action on the
host (`/add-homeassistant`), not something you can do from here.

The tools you have are exactly the capabilities the operator turned on for this group. If
someone asks for something you have no tool for, say that it isn't enabled rather than
improvising a way around it. That distinction matters to them: "I can't" and "I'm not allowed
to" have different fixes.

## When to reach for these

- **The vacuum** — "clean my room", "vacuum the kitchen", "stop the vacuum", "where's the
  robot", "is it done yet", "how much battery does it have".
- **The car** — "turn on the AC", "is the car locked", "how much charge is left", "where's the
  car", "start charging".
- **The printer** — "how much ink is left", "is the printer online", "why won't it print", "is
  there enough toner for this".

Read the tool descriptions for what each one takes. They carry the specifics; this file is
about the judgement.

## The printer is for *knowing*, not for printing

`printer_status` reads the printer. **It cannot print anything**, and there is no other
`mcp__homeassistant__*` tool that can — Home Assistant exposes printer sensors, not a way to send
a document, and it cannot see the job queue either.

So if someone asks you to print something, these tools are not the answer. Don't offer
`printer_status` as a substitute and don't describe reading the status as progress towards
printing. Whether you have some other way to print is a separate question with a separate
answer; nothing here depends on it either way.

Three things to get right when reporting:

- **`low` is the printer's own judgement, not yours.** A supply comes back with `low: true|false`
  measured against `low_at`. Report it. Don't invent a verdict for a level that has no `low`
  flag — say the number and leave it there.
- **A `null` value with a note means the printer doesn't measure that supply.** It does not mean
  empty. "The printer doesn't report a level for colour" is the true statement; "colour is at 0%"
  is not.
- **`unavailable` almost always means asleep.** Printers sleep hard and wake when a job arrives.
  Say "it's asleep — it should wake when something is sent to it" rather than "it's offline",
  which sounds like a fault.

When the status is `stopped`, the report usually carries a `reason` — `media-empty` is out of
paper, `media-jam` is a jam, `cover-open` is a door. **Lead with the reason**, translated into
plain words. "The printer is stopped" on its own is the least useful true thing you could say.

## "Clean my room"

The one flow worth spelling out, because it spans three tools and a piece of memory.

1. **`vacuum_get_room`** with the `sender` attribute of the incoming message, **verbatim**. On
   WhatsApp that looks like `972524525356@s.whatsapp.net`; on other channels it's that channel's
   handle. Copy it exactly — don't strip a suffix, don't substitute the display name, don't tidy
   it up. The stored key and the lookup key have to be byte-identical or the lookup misses and
   you'll ask someone for their room again after they already told you.
2. **Found?** Clean it with `vacuum_clean_area`. Don't ask again, don't confirm the room — they
   already told you once, and asking every time is the thing this memory exists to prevent.
3. **Not found?** `vacuum_list_areas`, then ask which one is theirs. Show them the **names**,
   not the area ids — `hkhdr_shl_myt` means nothing to anyone while "החדר של עמית" does.
4. **Save it with `vacuum_remember_room` as soon as they answer**, before starting the clean. If
   the clean fails you still want the mapping; you don't want to ask them twice.
5. Then `vacuum_clean_area`, and tell them it's started, naming the room.

**A one-off request about another room is not a statement about which room is theirs.** "Clean
the kitchen" means clean the kitchen — resolve it against `vacuum_list_areas` and don't save it.

**`system` is not a person.** If a request has no sender, or the sender is literally `system` —
a scheduled task, or the on-wake message a restart writes — then "my room" has no meaning. Ask
which area to clean instead of guessing, and don't write anything to the map.

If someone's saved room stops resolving, their platform identity string changed — on WhatsApp
this happens when a group flips to LID mode and the sender becomes `<id>@lid` instead of the
phone number. Ask which room is theirs again and save it under the new key.

## Ask first, for anything with a cost

These are real machines in someone's home, and the person asking is not always the only person
affected.

- **A whole-home clean** is long and loud in every room, including ones belonging to people who
  didn't ask. Say how many areas it covers and get an explicit yes.
- **Unlocking the car** leaves it unlocked until someone locks it again. Confirm before the
  first one in a conversation, and say what you did afterwards.
- **The car's AC** draws battery and keeps running. Worth a word if nobody's going to the car
  soon.
- **Switching the printer off** loses whatever it was printing, and many inkjets run an
  ink-wasting cleaning cycle every time they power up. Read the status first if anything might
  be in progress.
- **A specific room, asked for directly**, is already the instruction. Don't double-confirm
  that one — it's just friction.

Reading anything — the vacuum's state, the car's battery, the printer's ink — costs nothing and
needs no permission. Just answer.

`stop` is the exception in the other direction. It's what people say when something is wrong:
run it immediately and confirm afterwards, rather than asking a clarifying question first.

## Be honest about what actually happened

A tool returning successfully means Home Assistant **accepted and dispatched** the command. It
does not mean the machine moved, the room is clean, or the car heard about it. Cars are the
worst case — the command travels to the manufacturer's cloud and then to a vehicle that may be
asleep, so acceptance and effect can be minutes apart or never.

So:

- If someone asks "is it done?", **read the status**. Don't infer completion from the earlier
  call having succeeded.
- `unavailable` means the device is offline. Say that, rather than reporting it as idle or as a
  number.
- After locating the vacuum, the true statement is "it's beeping now, follow the sound". Home
  Assistant reports the vacuum's *state*, never its position — "it's in the hallway" would be
  invented.

## Rules

- **One job per request. Never loop.** If something needs re-issuing, ask first.
- **Never re-send a command because the reply was slow.** A slow reply is not a failure, and
  re-sending a clean restarts the job.
- **Never invent an `area_id` or an entity id.** Area ids come from `vacuum_list_areas` and
  nowhere else — never transliterate a name into one; the ids are generated by Home Assistant
  and a guess either fails or cleans a different room.
- **Don't operate anything on your own initiative.** Only when someone asks.
- **Report errors as they came back.** If a tool says a capability isn't enabled or a device is
  unreachable, pass that on; don't substitute a different action that "does roughly the same
  thing". Turning a failed room clean into a whole-home clean is a much worse outcome than an
  error message.
