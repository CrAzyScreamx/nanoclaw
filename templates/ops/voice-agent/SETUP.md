# Setup — host-side, before the first message

Follow this in Claude Code **on the host**, straight after

```bash
ncl groups create --template ops/voice-agent --name "Voice Line"
```

and **before** wiring the group to a channel.

Nothing here can be asked in chat. Every item below is a secret, a paid-account
decision, or a dashboard step: an unwired group has nobody to ask, a key pasted
into a message is a key in a transcript and a container's context, and the phone
number import needs a browser. Settle it here so the agent's first message is
about what it can do rather than what it is missing.

Every step is idempotent — safe to re-run, safe to resume after an interruption
— and nothing here deletes anything.

## The rule that outranks the steps

**No API key passes through this session.** Where a step needs the raw value of
a key, hand the command to the operator to run **in their own terminal**, outside
Claude Code, and wait for them to say it is done. Do not ask them to paste a key
here, do not put one on a command line you run, and do not write one to a file.

What you run yourself is only ever one of two things: a read-only check, or a
command whose arguments are identifiers (an `AC…` Account SID, a group id, a
host pattern). That split holds for the whole document.

## 1. Resolve the group

```bash
ncl groups list
```

Note two things and reuse them below: `<group-id>`, the `ag-…` id every
`ncl … --id` wants, and `<folder>`, the directory under `groups/` derived from
the agent name at stamp time.

| Host path | Inside the container | Holds |
|---|---|---|
| `groups/<folder>/` | `/workspace/agent/` | the whole workspace |
| `groups/<folder>/voice-line/` | `/workspace/agent/voice-line/` | `config.json`, `state.json`, `calls.jsonl` |
| `groups/<folder>/plugins/voice-agent/` | `/workspace/agent/plugins/voice-agent/` | this plugin, read-only |

This file and everything under `setup/` ship inside the plugin, so the agent can
read them too. When it hits a credential problem later it quotes from here
rather than inventing a procedure — that is the point of settling it in one place.

## 2. The two paid accounts — decide before spending

Two separate bills, neither of them NanoClaw's, and the template is unusable
without both. Put this to the operator **first**, because a plan chosen after
the fact is a plan chosen twice.

- **ElevenLabs Agents Platform** — usage-metered, call minutes billed:
  <https://elevenlabs.io/pricing/agents>. Importing a phone number and placing
  outbound calls sit on a **paid tier (Starter or above)**, so on Free the
  operator can write and test personas but the line itself will not work.
  Vendor gating moves; confirm it on that page rather than trusting this
  sentence.
- **The carrier** — Twilio, Exotel or a SIP trunk vendor bills separately for
  the number and its minutes.

Say both out loud, get an explicit go-ahead, and only then start step 3.

## 3. The ElevenLabs key → the OneCLI vault

Required. The key gets its permissions in the ElevenLabs dashboard and its home
in the vault, where the gateway injects it by destination host. The non-standard
`xi-api-key` header is what makes the on-demand connect-link flow useless here,
so this is a typed command or three fields in the UI — there is no shortcut.

→ **`setup/elevenlabs.md`** (key permissions, the vault entry, verifying it,
secret mode, and who else on this install can reach the key).

## 4. The phone number

The operator imports the number in the ElevenLabs dashboard. Not you, and not
the agent: `POST /v1/convai/phone-numbers` takes a raw carrier SID and token, so
routing it through either of us would put real credentials in a transcript.

The carrier behind that number also decides whether "hang up this call" can ever
work here, which is why it comes before step 5.

→ **`setup/phone-number.md`**.

## 5. Hang-up (optional) — Twilio only

Ask whether the group wants to end calls in flight. If not, skip this entirely:
dialing, answering, campaigns and every report work with the ElevenLabs key
alone, and the persona's `end_call` tool still lets a call end itself.

If yes, and only if the number from step 4 is on **Twilio** — the one carrier
with a hang-up adapter here — it needs a Twilio **API key** in the vault and the
`AC…` Account SID on disk. Two values, two different places, and swapping them
produces a 401 that reads exactly like a bad key.

→ **`setup/hangup-twilio.md`**.

## 6. Guardrails — the credit cap, the dial rule and the sweep cadence

Two decisions that cost real money if they are left at their defaults and nobody
looks — whether the key carries a credit cap (the only ceiling anyone enforces
for you), and how often the two sweeps wake the container — plus one limitation
to state rather than configure: the persona's own "confirm every dial" rule is a
strong default, not enforcement.

→ **`setup/guardrails.md`**.

## 7. Runtime settings — offer, do not force

Templates carry no provider, model or effort, so these are decisions to put to
the operator, not defaults to apply silently.

```bash
ncl groups config update --id <group-id> --model <model>   # then: ncl groups restart --id <group-id>
```

This agent reasons about consent, carrier capability and what a transcript
actually said, and it writes the messages a caller's answers turn into. That is
not a small-model workload; the tools do the API work, but the judgement calls
are the job. Recommend a mid or large model, and say why rather than just naming
one.

## 8. Hand off

Wire the group to a channel — `/manage-channels`, or `ncl wirings create` — and
stop there.

The **welcome** skill runs on the first incoming message. It reads the line
read-only, introduces the agent, and says plainly what this install can and
cannot do — which persona answers, whether hang-up works on this carrier, and
what it will never do without an explicit yes. It asks for no keys, because by
then there is nothing left to ask for.

One thing to expect: if welcome reports a `401` from `lines.ts list`, the vault
entry is missing, wrong, or not visible to this agent. That is a host-side fix
and it comes straight back here — `setup/elevenlabs.md`, the verification
section. The agent is right to refuse to fix it in chat.
