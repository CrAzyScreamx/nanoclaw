# Where the line's state lives

Two trees, and the difference between them is not cosmetic.

- `/workspace/agent/plugins/voice-agent/` — the plugin: tools, skills, this file.
  **Mounted read-only.** Nothing is ever written there, by you or by a tool. A
  write attempt fails; treat one as a bug, not as a permission to work around.
- `/workspace/agent/voice-line/` — the runtime state, read-write. The tools own
  it. **You may read any of it freely; let the tools do the writing.** Hand-editing
  these files puts your notion of the line out of step with the provider's.

Everything below is under `/workspace/agent/voice-line/`.

## `config.json` — the line inventory and the carrier facts

Recorded at setup and refreshed whenever lines are listed.

```json
{
  "provider": "elevenlabs",
  "lines": {
    "<lineId>": {
      "number": "+15550100",
      "label": "Support line",
      "carrier": "twilio",
      "personaId": "<personaId or null>"
    }
  },
  "twilio": { "accountSid": "<account sid>" },
  "updatedAt": 1730000000
}
```

- `lines[<id>].carrier` is one of `twilio`, `exotel`, `sip_trunk`. It comes from
  the provider, never from a guess, and it is what decides which outbound-call
  route is used and whether hang-up is possible at all.
- The `twilio` block appears only once that carrier is configured, and holds
  **identifiers only**. An Account SID is an identifier, not a secret — it
  travels in the request URL. The **API key** (SID `SK…` + secret, *not* the
  account's Auth Token) lives in the OneCLI vault and is injected by the gateway
  at request time. `lines.ts carrier --check` proves the vault half works without
  placing or ending a call.
- That block is often **already here when you arrive**: `SETUP.md` seeds the
  Account SID on the host, once, before the container has ever run. That is the
  only hand-write this file ever gets. From then on `lines.ts carrier` owns it —
  read what is there rather than asking for a value you already have.
- **Twilio is the only carrier with a hang-up route here.** A line on `exotel` or
  `sip_trunk` still dials, answers and reports; it just cannot be ended in
  flight, and there is nothing to record for it. A config written by an older
  build may still carry `exotel` / `sip` blocks — they are simply unused.
- **No token, key, password or Basic value is ever written to this file**, or to
  anything else under `/workspace/agent/voice-line/`. If you ever see one here,
  that is an incident: tell the user, and do not copy it anywhere.

## `state.json` — the sweep watermarks

```json
{
  "watermarks": { "inbound": 1730000000, "outbound": 1730000000 },
  "lastSweep": { "inbound": 1730000600, "outbound": 1730000600 }
}
```

Unix seconds. `watermarks` is how far each direction has been reported up to;
`lastSweep` is when the sweep last ran. Only `sweep.ts` advances these. Editing
them by hand either re-reports calls the user has already seen or skips calls
nobody ever sees.

## `calls.jsonl` — the append-only call log

One JSON object per line, newest last, trimmed to the most recent 2000 entries.
Written when a call is placed and when a sweep reports one. It is a local
record, not the source of truth: for anything authoritative — status,
transcript, collected data — read the provider with
`bun /workspace/agent/plugins/voice-agent/tools/calls.ts show <id>`.

## `campaigns/<campaignId>.json` — one record per submitted campaign

Written by `campaign.ts submit`: the campaign's name, the line and persona it
runs on, the **path of the recipient file it was submitted from**, and the id to
check status with. The recipient list itself is **not** stored — do not promise
to re-read numbers or variables from here. Live progress comes from
`campaign.ts status <id>`, not from this file.

## Which tool writes what

| Tool | Writes |
|---|---|
| `lines.ts list` | `config.json` — the line inventory and each line's carrier |
| `lines.ts assign` | `config.json` — the persona now answering that line |
| `lines.ts carrier` | `config.json` — Twilio's Account SID, the one identifier hang-up needs. Identifiers only; it refuses anything credential-shaped. `--check` writes nothing and probes the vault credential instead |
| `call.ts dial` | appends to `calls.jsonl` |
| `sweep.ts inbound\|outbound` | advances `state.json` watermarks; appends the reported calls to `calls.jsonl` |
| `campaign.ts submit` | `campaigns/<campaignId>.json` |

`personas.ts` and `calls.ts show` write nothing — they read the provider.
