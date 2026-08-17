# Reference: a call came back 401 — what you do about it

Nothing in this container holds a credential. The **OneCLI gateway** is a MITM
egress proxy: it matches the destination host of every outbound HTTPS request
and injects the right header. The tools send **no** auth header at all — that is
deliberate, not an oversight. A 401 or 403 means the vault has no entry for that
host, has the wrong one, or is not offering it to this agent.

**Connecting is not your job and cannot be done from here.** It was settled
host-side before this group was wired, in the template's `SETUP.md`. If it is
broken, it gets fixed there too — by the operator, on the host, in their own
terminal. You do not walk anyone through it in chat, you do not ask for a key,
and you do not retry the call hoping it resolves.

What you do is make the fix cheap to find: name the service, name the cause the
tool already named, name the file, and stop.

## The message to send

One message, four parts, no questions attached:

> **What failed** — "`lines.ts list` came back 401 from `api.elevenlabs.io`."
>
> **What it means** — the vault entry for that host is missing, wrong, or not
> visible to this agent. Whatever the tool's error named as the likely cause,
> repeat it verbatim; it is more specific than anything you would infer.
>
> **Who fixes it and where** — the operator, on the NanoClaw host, from
> `plugins/voice-agent/SETUP.md`: `setup/elevenlabs.md` for the ElevenLabs key,
> `setup/hangup-twilio.md` for the Twilio carrier credential. Both have the
> exact command and the verification.
>
> **What still works** — a failing carrier check costs hang-up and nothing else;
> dialing, answering and reporting are unaffected. A failing ElevenLabs check
> costs everything, so say that instead of implying a partial service.

Then wait to be told it is done, and re-run the same read-only call that failed.
Nothing else changes in the meantime.

## If they ask you to just tell them the command

Read it out of `SETUP.md` and `setup/*.md` and quote it — those files ship
inside the plugin at `/workspace/agent/plugins/voice-agent/`, so you are
relaying the operator's own runbook rather than reconstructing one from memory.
Two things to carry across when you do:

- it runs **on the host, in their terminal**, not with `!` in a Claude Code
  session and never in this chat;
- the key goes into an exported variable first, so it never appears in the
  command line they type.

Do not paraphrase the command, do not fill in a key placeholder, and do not
offer to run it. If they paste a key at you anyway: do not repeat it back, do
not store it, do not write it to a file — say it cannot be used here and point
back at the host.

## The three shapes this failure takes

| Symptom | Almost always | Fix lives in |
|---|---|---|
| Every ElevenLabs tool 401s | no vault entry, or `Bearer {value}` instead of `{value}` on the non-standard `xi-api-key` header | `setup/elevenlabs.md` |
| ElevenLabs works, `carrier --check` fails | the Twilio Basic value carries a newline from an unwrapped `base64`, or the `AC…` Account SID was used where the `SK…` key SID belongs | `setup/hangup-twilio.md` |
| It worked yesterday and 401s today | the agent was moved to `selective` secret mode, or the key was rotated at the vendor | `setup/elevenlabs.md`, secret mode |

The middle row is worth knowing by heart: it is the one failure that looks
exactly like a bad key and is not one.

## What has no vault entry at all

- **Exotel and SIP-trunk hang-up.** This template ships a Twilio adapter and no
  other, so those lines have no hang-up route for a credential to unlock. Never
  walk someone toward a vault entry for `api.exotel.com` or a trunk vendor's
  host: it would cost them a key and buy nothing. `ending-a-call.md` has what to
  offer instead.
- **SIP trunk digest username and password.** They are set in the ElevenLabs
  dashboard and nowhere else. The reason is structural: the vault rewrites
  **headers on outbound HTTPS**, while those values travel inside a **JSON body**
  to ElevenLabs — so there is no header for the gateway to inject them into, and
  anywhere else in this container means plaintext on disk. `lines.ts` and
  `personas.ts` refuse to write them; hand the user the dashboard step.
- **The phone number import.** `POST /v1/convai/phone-numbers` takes a raw
  carrier Account SID and Auth Token, so it is a dashboard step the operator
  does. You never import a number.

## Teardown

If someone asks to disconnect: deleting the vault entry only removes NanoClaw's
copy. The key keeps working — and keeps being **billable** — until it is revoked
in the vendor's dashboard. Say both halves; one of them is the one that stops
the money.
