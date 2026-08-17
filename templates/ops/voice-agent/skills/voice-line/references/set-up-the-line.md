# Reference: setting up the line

Getting from "connected" to "this number is answered by someone useful". The
credential half is already done — it was settled host-side in `SETUP.md` before
this group was wired — so what is left is the part that genuinely belongs in a
conversation: survey, persona, assign.

Four steps, in order, one message each.

## 0. What is not yours

- **The number import.** The operator adds it in the ElevenLabs dashboard →
  **Phone Numbers** → label, number, carrier SID + token. Never you: that
  endpoint takes a raw carrier Account SID and Auth Token, so routing it through
  you would put real credentials in chat. If a number is missing, that is the
  step to name.
- **Every key.** They live in the OneCLI vault, on the host. A 401 is not a
  thing to work around — see `connect-provider.md`.

Your side of the line is: survey, persona, assign.

## 1. Survey — and detect the carrier

```bash
bun /workspace/agent/plugins/voice-agent/tools/lines.ts list
```

This is the detection step. It records each line's carrier into
`/workspace/agent/voice-line/config.json`, which every later hang-up decision
reads. Report each line by number, label, carrier, and who answers it.

What the detected carrier means — not something to ask about, something to
**tell** them:

| Detected carrier | Dials, answers, reports | Ends a call in flight |
|---|---|---|
| `twilio` | yes | **yes**, if the carrier credential is in place and `--check` passes |
| `exotel` | yes | **no** — no hang-up adapter ships here |
| `sip_trunk` | yes | **no** — same |

On an Exotel or SIP-trunk line there is nothing to connect and nothing to ask
for: no adapter exists for a credential to unlock. Say up front that calls on it
cannot be ended in flight, and offer the persona's `end_call` tool in step 3.

### Prove the credential before a live call does it for you

```bash
bun .../tools/lines.ts carrier --check
```

**Recorded identifiers and a working credential are two different claims**, and
only the second one makes hang-up work. `--check` settles it with one read-only
request per carrier and prints `pass` / `fail` with the exact fix. Run it at
first contact — never answer "is hang-up set up?" from the identifier half
alone, and never verify by hanging up a real call.

A `fail` is a host-side problem: report it, point at `setup/hangup-twilio.md`,
and say hang-up is unavailable until it is fixed. Do not try to fix it from here.

Twilio is the only carrier probed, because it is the only one that can hang up.

### If the Account SID was never recorded

`carrier --check` on a Twilio line with no Account SID on file says so. The SID
normally arrives from setup, seeded into `config.json` on the host — but if it
did not, it is the one carrier value you may take in chat, because it is an
**identifier, not a secret**: it travels in the request URL, and Twilio's API
will not accept it as a credential.

```bash
bun .../tools/lines.ts carrier --twilio-sid <AccountSid>
```

Ask for the `AC…` value only, say plainly that it is an identifier and that the
key it pairs with stays in the vault, and run `--check` straight after. That is
the only carrier flag there is; `--exotel-*` and `--sip-*` are **refused by
name**, because they configured adapters that no longer exist and accepting them
silently would look like hang-up had been set up. Run it with no flags to see
what is recorded.

## 2. Create the persona

```bash
bun .../personas.ts create \
  --name "Front desk" \
  --prompt @/workspace/agent/voice-line/front-desk-prompt.md \
  --first-message "Hi, this is the front desk — how can I help?" \
  --language en
```

`--prompt` takes text inline or `@path` to read a file, which is easier to edit
than a long shell string. `--voice <voiceId>` picks a specific voice; without it
the provider default applies.

Write the prompt with the caller in mind: who the persona is, what it may and may
not promise, what it should collect, and **when the call is finished**. That last
part is what makes the next step work.

## 3. The `end_call` system tool is part of provisioning, not an extra

`personas.ts create` includes it by **default**. Leave it that way unless the
user has a specific reason not to, and say what opting out costs: a persona
without `end_call` **runs until the callee hangs up**, and on a line whose
carrier credential is not configured nothing else can end it either.

Check an existing persona with `personas.ts show <id>` — it prints
`end_call tool: yes | NO`. Add it to one that lacks it:

```bash
bun .../personas.ts update <personaId> --end-call-tool
```

## 4. Wire persona ↔ number

```bash
bun .../lines.ts assign <lineId> <personaId>
```

`--none` clears it, which leaves inbound calls to that number unanswered. Confirm
the result by reading it back from the tool's output, not from memory.

## Refusals you will hit (and should not work around)

`lines.ts` and `personas.ts` refuse any flag that looks like trunk configuration
or a credential — `inbound_trunk_config`, `outbound_trunk_config`, a SIP digest
`username`/`password`, anything token- or secret-shaped. This is structural, not
a policy toggle: the OneCLI vault rewrites **headers on outbound HTTPS**, while
those values ride inside a **JSON body** to ElevenLabs, so they cannot be
vault-backed, and anywhere else in this container means plaintext on disk.

When you hit that refusal, hand the user the dashboard step. Do not try another
flag spelling, do not write the value into a file, and do not ask them to paste
it to you.

## Done means

- Every line's carrier is recorded and reported.
- The persona exists, has a prompt, and has `end_call`.
- The persona is assigned to the number.
- The user has been told, in plain words, whether "hang up this call" will work
  on this install — see `ending-a-call.md`.
