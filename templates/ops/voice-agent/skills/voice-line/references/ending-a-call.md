# Reference: ending a call

**There is no ElevenLabs REST route that terminates a call.** So hang-up happens
at the **phone network**, and **only one carrier can do it here: Twilio.** A line
on Exotel or a SIP trunk works for everything else and simply cannot be hung up
in flight. Know which carrier this line is on *before* someone asks you to hang
up, not after.

## The workflow

```bash
bun /workspace/agent/plugins/voice-agent/tools/calls.ts list --live
bun /workspace/agent/plugins/voice-agent/tools/call.ts  hangup <conversationId>
```

`--live` means status `initiated`, `in-progress` or `processing`. A bare
`hangup` with **exactly one** live call uses it; with **more than one** it
**refuses and lists them** rather than guessing which call to kill — name the id
explicitly. With none, it says so. `--dry-run` reports the route, the carrier,
and the carrier-side call sid without sending anything.

On success the tool **names the route it took** — `carrier` or `monitor`. Repeat
that to the user; "it's ended" without the route hides which mechanism they are
depending on.

## The route needs the carrier-side id

Where it comes from:

```
GET /v1/convai/conversations/{conversationId}  →  metadata.phone_call.call_sid
```

`calls.ts show <id>` prints it as `call sid`. For a call **this agent placed**,
the outbound-call response already returned it, so no extra fetch is needed.

## Carrier routes

### Twilio

```
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
Content-Type: application/x-www-form-urlencoded

Status=completed
```

Needs the Account SID in `config.json` and a **Twilio API Key** in the vault
(`api.twilio.com`, `Authorization`, `Basic {value}`, value = base64 of
`SK…:<key secret>`). **Not the Account Auth Token** — see
`connect-provider.md` for why, and for which key type to create.

This is the route that works most reliably, and it is the only carrier with a
read-only credential probe:

```bash
bun .../lines.ts carrier --check
```

Run that **before** anyone asks you to hang up, not after it fails. It reports
`pass` / `fail` per carrier without touching a live call. If it says `fail`, say
so up front — the credential is wrong and hang-up will not work, whatever the
persona's `end_call` tool does independently.

### Exotel and SIP trunk — no hang-up route here

**This template ships a Twilio hang-up adapter and nothing else.** Exotel and SIP
trunk lines are still detected, still dialable, and still reported by
`lines.ts list` — the carrier is real, and outbound calling picks its route from
it. What they do not have is a way to end a call in flight.

That is deliberate. Neither route was ever confirmed against a live account:
Exotel's Legs API lookup was unverified, and there is no generic SIP hang-up at
all — ElevenLabs ends a SIP call with a `BYE` that nothing in an agent container
can send, leaving only the trunk vendor's own REST API, which differs per vendor
and may not address a trunk call at all (Telnyx requires a Call Control
application; a plain elastic trunk call is not one). An unverified hang-up is
worse than no hang-up: it fails as a call that keeps running while the agent
reports success.

So on those lines, say it plainly and early — **before** anyone asks you to hang
up, not after it fails — and offer the route that does work: the `end_call`
system tool on the persona. Both may come back once someone has tested them on a
real account.

## The two carrier-independent routes

### `end_call` on the persona — the one that always works

ElevenLabs' `end_call` system tool lets the voice agent hang up **itself** when
its stopping conditions are met. It is configuration rather than live control —
it cannot end a call already in progress on your command — but it is available on
**every plan and every carrier**, and a persona without it runs until the callee
hangs up.

```bash
bun .../personas.ts show   <personaId>          # end_call tool: yes | NO
bun .../personas.ts update <personaId> --end-call-tool
```

It applies from the **next** call onward, never to the one currently running.
Say that when you offer it as the alternative.

### The monitor WebSocket — enterprise only

```
wss://api.elevenlabs.io/v1/convai/conversations/{conversationId}/monitor
→ {"command_type": "end_call"}
```

The same channel also carries `transfer_to_number` and `enable_human_takeover`.
It requires an **enterprise plan**, a key with ***ElevenAgents: Write***, and
the **EDITOR** workspace role on the account (granted in workspace settings, not
on the key form) — and the upgrade has to survive the OneCLI MITM proxy, which
**has not been confirmed end to end**. If the upgrade does not traverse the
gateway, the route is reported unavailable **with the reason named**, never left
to fail obscurely.

## What to tell the user

Match what you say to what is actually true here:

- Carrier credential configured **and `carrier --check` passed** → "yes, I can
  end a call in flight." Configured-but-unprobed is not the same claim: say
  "it is set up, but I have not proved the credential works — one read-only
  check will," and run it.
- Line is on **Exotel or a SIP trunk**, or Twilio has no vault entry, or the
  probe failed → "I cannot end a call in flight on this line, because *<the named
  reason>*. What I can do is give the persona the `end_call` tool so it ends
  calls itself when it is done." The reason is always named by the tool — repeat
  it rather than saying "it doesn't work".
- Never say "I hung up" unless the tool returned a route.
