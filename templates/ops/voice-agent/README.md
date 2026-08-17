# Voice Agent Template

A NanoClaw template for running a **phone line**. The agent takes inbound calls
and places outbound ones through the [ElevenLabs Agents
Platform](https://elevenlabs.io/pricing/agents): it configures which persona
answers which number, dials out on confirmation, sweeps finished calls into
triage, and works the transcripts.

The agent is never the voice on the call. A NanoClaw agent is a text agent in a
container with no audio path and no public HTTP ingress, so it is the *operator*
of the voice agents rather than one of them. Two consequences shape everything
here: nothing outside can POST into the container, so inbound calls are learned
by **polling** on a scheduled task (post-call webhooks are unusable); and no key
lives in the container, so every tool sends **no auth header** and the OneCLI
gateway injects credentials by destination host.

## This is a paid service — read this first

**The ElevenLabs Agents Platform is a paid, usage-metered service.** Pricing and
tiers: <https://elevenlabs.io/pricing/agents>.

- Tiers are **Free, Starter, Creator, Pro, Scale, Business, Enterprise**.
- **Which one you need is decided by phone-number import**, which is what this
  template is built around: importing a number and placing outbound calls sit on
  a **paid tier (Starter or above)**, so on **Free** you can write and test
  personas but the line itself — inbound answering, `call.ts dial`, campaigns —
  will not work. Confirm the current gating on the pricing page above before you
  commit to a plan; where a vendor draws that line moves, and this README does
  not want to be the stale copy of it.
- **Call minutes are billed**, and the telephony provider's cost is passed
  through at cost on top of them.
- You bring **your own key**. This template ships no credential of any kind, and
  no prices are quoted here because they change — read them from the vendor.
- The **carrier is a second, separately paid account.** Twilio, Exotel, or a SIP
  trunk vendor bills you directly for the phone number and the minutes; that
  account is yours, not ElevenLabs'.
- The live-call **monitor** route (ending a call in flight over the ElevenLabs
  control WebSocket) needs an **enterprise plan**, an **_ElevenAgents: Write_**
  key, and the **EDITOR** workspace role on the operator's own account — that
  role is granted in workspace settings, not on the API-key form. Everything
  else in this template works without it.

Nothing in the template is usable without an ElevenLabs account that can create
agents and import a phone number.

## Layout

```
voice-agent/
├── plugin.json                         # Agent Plugins manifest (marks the folder as a plugin)
├── README.md                           # this file
├── SETUP.md                            # host-side runbook: run it after stamping, before wiring
├── setup/                              # the long half of SETUP.md, one file per decision
│   ├── elevenlabs.md                   #   the required key: permissions, vault entry, verification
│   ├── phone-number.md                 #   carrier choice and the dashboard import
│   ├── hangup-twilio.md                #   optional: the Twilio credential that buys hang-up
│   └── guardrails.md                   #   the key credit cap, the dial rule and sweep cadence
├── ai.nanoco.nanoclaw/
│   ├── context/
│   │   ├── instructions.md             # the persona — confirm before every dial
│   │   └── additional_context/
│   │       └── workspace-layout.md     # where call records, watermarks and line config live
│   └── tasks/
│       ├── inbound-sweep.md            # script-gated, created PAUSED
│       └── outbound-sweep.md           # script-gated, created PAUSED
├── skills/
│   ├── welcome/SKILL.md                # first contact → connect the key, survey the line
│   └── voice-line/
│       ├── SKILL.md                    # router: plays → references
│       └── references/
│           ├── connect-provider.md     # OneCLI vault setup (first run)
│           ├── set-up-the-line.md      # number import, persona ↔ number, end_call tool
│           ├── ending-a-call.md        # the two hang-up strategies and what each needs
│           ├── placing-calls.md        # confirmation protocol, dynamic variables
│           ├── campaigns.md            # batch calling
│           ├── working-results.md      # triage inbound, follow up outbound
│           └── providers.md            # capability matrix; adding a provider
└── tools/                              # TypeScript CLIs run with `bun`; no build step
    ├── tsconfig.json                    # editor/typecheck only; nothing is built
    ├── package.json                     # dev-only: the types the typecheck needs
    ├── lib/
    │   ├── provider.ts                 # abstract VoiceProvider + domain types + errors
    │   ├── registry.ts                 # name → provider; unknown names fail loudly
    │   ├── http.ts                      # proxy/CA-aware fetch, no auth header, typed errors
    │   ├── cli.ts                       # subcommand + flag parsing, --json, exit codes
    │   └── state.ts                     # line config, sweep watermarks, call log
    ├── providers/elevenlabs/
    │   ├── types.ts                     # wire shapes for /v1/convai/*
    │   ├── client.ts                    # REST calls only
    │   ├── monitor.ts                   # control-channel WebSocket (end_call)
    │   ├── persona-body.ts              # PersonaInput → conversation_config; refuses trunk creds
    │   └── provider.ts                  # maps wire shapes → domain model
    ├── carriers/
    │   ├── index.ts                     # carrier kind → Carrier, or a named reason
    │   └── twilio.ts                    # POST Calls/{Sid}.json Status=completed; the only adapter
    ├── lines.ts                          # list | assign | carrier
    ├── personas.ts                       # list | show | create | update
    ├── call.ts                           # dial | hangup
    ├── campaign.ts                       # submit | status | cancel
    ├── calls.ts                          # list [--live] | show
    └── sweep.ts                          # scheduled-task gate; emits {"wakeAgent": …}
```

There is **no `mcp.json`** and no MCP server. A stdio MCP server does not inherit
the container environment, so `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` would be
dropped and every call would 401 with no hint why. The tools are ordinary CLI
scripts the agent runs through Bash, so the proxy and the CA just work. Because
there is no `mcp.json`, there is no `"placeholder"` env var anywhere in this
template either.

## Credentials: via the OneCLI vault, never in the template

No API key lives in this folder, in the agent container, or in chat. The OneCLI
gateway holds your keys and injects them into outbound HTTPS at the proxy
boundary, matched on the destination host.

| Service | API host to match | Auth style | Scopes the key needs | Where to get the key |
|---|---|---|---|---|
| ElevenLabs (required) | `api.elevenlabs.io` | header `xi-api-key`, value format `{value}` — **no `Bearer`** | **ElevenAgents: Write** (personas, phone numbers, dialing, batch calling, transcripts) — the single scope covering `/v1/convai/`, and the only one this template needs. **Read** is enough for `lines.ts list`, `personas.ts list/show` and `calls.ts`, and nothing else. | ElevenLabs dashboard → API keys (set the scope when you create it) |
| Twilio (optional, hang-up only) | `api.twilio.com` | `Authorization`, `Basic {value}` where value is base64 of `ApiKeySid:ApiKeySecret` — the `SK…` key SID, **not** the `AC…` Account SID, and **not** the Auth Token | Create an **API key**, not an Auth Token: a **Standard** key reaches everything except the Accounts and Keys resources, and a **Restricted** key can be narrowed to **Voice → Calls, read + write** (write hangs up, read lets `carrier --check` verify it). Either can be revoked alone; the Auth Token cannot. | Twilio console → Account → API keys & tokens |

**The Twilio row is optional, and it buys hang-up only.** Dialing, answering,
transcripts and reporting all work with the ElevenLabs key alone. Adding the
Twilio credential is what makes "end this call now" possible; without it the
agent says so up front instead of discovering it mid-call.

**Twilio is the only carrier that can end a call in flight here.** `lines.ts list`
reads each number's carrier (`twilio` / `exotel` / `sip_trunk`) and records it;
all three dial, answer and report normally, but Exotel and SIP-trunk lines ship
no hang-up adapter. Neither route was ever confirmed against a live account —
Exotel's Legs API lookup was unverified, and there is no generic SIP hang-up at
all, since ElevenLabs ends a SIP call with a `BYE` no container can send — and an
unverified hang-up is worse than none: it fails as a call that keeps running
while the agent reports success. Both can return once someone tests them for
real. On those lines the working route is the persona's `end_call` system tool.

Two things that look like credentials but are not, and are treated accordingly:

- **An Account SID is an identifier, not a secret.** Twilio's Account SID
  appears in the request URL, so it lives in
  `/workspace/agent/voice-line/config.json`. Only the key reaches the
  vault. On Twilio the two are easy to confuse and the confusion is silent: the
  `AC…` Account SID goes in `config.json` and stays in the URL, while the vault
  value is built from the `SK…` **API key** SID and its secret. Swapping them
  produces a 401 that looks exactly like a bad key.
- **SIP trunk digest username/password belong in the ElevenLabs dashboard**, and
  never in the vault or the workspace. The reason is structural: the vault
  rewrites **headers on outbound HTTPS**, while those values ride inside a JSON
  body to ElevenLabs. They cannot be vault-backed, and anywhere else in the
  container means plaintext. The tools refuse to write trunk-config blocks and
  hand you the dashboard step instead.

## Setup: `SETUP.md`, on the host, before wiring

**None of the setup happens in chat.** Every piece of it is a secret, a
paid-account decision, or a dashboard step: an unwired group has nobody to ask,
a key pasted into a message is a key in a transcript and a container's context,
and the number import needs a browser. So it is a host-side runbook, followed in
Claude Code on the host straight after stamping and **before** the group is
wired to a channel.

[`SETUP.md`](SETUP.md) is that runbook, and `setup/` is its detail:

| Step | Covers | File |
|---|---|---|
| Paid accounts | ElevenLabs tier gating and the separate carrier bill, decided before anything is spent | `SETUP.md` §2 |
| The key | permissions to tick, the vault entry (`xi-api-key`, `{value}`, **not** `Bearer`), verifying it through the gateway with `onecli run`, secret mode, and who else on the install can reach it | `setup/elevenlabs.md` |
| The number | which carrier to buy from and why it decides hang-up; the dashboard import the agent must never do | `setup/phone-number.md` |
| Hang-up | optional, Twilio only: API key vs Auth Token, the base64 newline that reads as a bad key, the `AC…` SID on disk | `setup/hangup-twilio.md` |
| Guardrails | the per-key credit cap (the only real ceiling), why the persona's dial rule is not enforcement, and what sweep cadence costs | `setup/guardrails.md` |

By the time the group is wired there is nothing left to ask for, which is what
lets the **welcome** skill spend first contact on what the line can and cannot
do — it surveys read-only, reports, and refuses to conduct a vault setup in
chat.

`SETUP.md` and `setup/` ship inside the plugin, so the agent can read them too:
on a 401 it quotes the operator's own runbook instead of inventing a procedure.

### Working on the template itself

The tools are run, never built. To typecheck them, install the dev-only types
first — and **delete `node_modules/` afterwards**: the registry check rejects
symlinks anywhere in a template, and a package manager's `.bin/` is full of them.

```bash
cd ops/voice-agent/tools && bun install && bunx tsc --noEmit -p tsconfig.json
rm -rf node_modules bun.lock          # before node scripts/check-templates.mjs
```

## Stamp an agent from this template

```bash
ncl groups create --template ops/voice-agent --name "Voice Line"
```

Then follow [`SETUP.md`](SETUP.md) on the host — key, number, hang-up,
guardrails — and only then wire the group to a channel (`/manage-channels`).
Wiring first means the agent's first message is a list of things it cannot do
yet.

## The two sweeps, and what cadence costs

Both scheduled tasks ship **paused**. Resume the ones you want — the decision
walkthrough, including which one most installs should leave paused, is
`setup/guardrails.md` §3:

```bash
ncl tasks list --group <group-id> --status paused
ncl tasks resume --id <task-id>
```

| Task | Default schedule | What it does |
|---|---|---|
| `inbound-sweep` | `*/10 * * * *` | polls for finished **inbound** calls, triages them, reports in one message |
| `outbound-sweep` | `7,22,37,52 * * * *` | polls for finished **outbound** calls and proposes follow-ups |

**Cadence is a real cost, not a free knob.** Every fire spawns the group's
container for a few seconds if it is idle. `*/10 * * * *` is roughly **144
spawns a day** on a line where nobody called. Trade promptness for spawns
deliberately:

- widen the cron — `*/30 * * * *` halves it again;
- restrict it to business hours — `*/15 9-18 * * 1-5` is ~200 fires a week
  instead of ~4,000;
- if you only make **outbound** calls, leave `inbound-sweep` paused entirely.

The outbound schedule is deliberately **off the ten-minute grid**. Both sweeps
read-modify-write the same `state.json`, so two fires landing on the same second
can lose each other's record of what was already reported — which shows up as a
call reported twice. Keep the two schedules from sharing minutes when you retune
them.

Both tasks carry a `script:` gate, which is not optional: ungated tasks are
capped at 4 fires per 24h, while script-gated ones may run often. The gate is
`sweep.ts`, whose last stdout line is a single JSON object with a boolean
`wakeAgent`. On `false` nothing spawns a turn; on `true` the call summaries are
rendered into the agent's prompt as a **Script output:** block. The runner caps
the script at 30s and 1MB, so the sweep sends at most ~15 calls per fire
(summaries only, no transcripts) and reports a `truncated` count rather than
silently dropping the rest. A call counts as finished when it is `done` **or**
`failed`, and the watermark never advances past a call still in flight, so a
call longer than the interval — or one of a pair that overlapped — arrives at
the fire after it ends instead of being skipped.

## There is no hard gate on placing a call

The persona's "confirm before every dial" rule is a **strong default, not
enforcement**. NanoClaw's own guard seam does not see a plain HTTPS call made
from inside a container, so a model that talks itself past the rule is not
stopped by it.

Nothing in this template closes that gap. The **capped key** is the only real
ceiling on what a runaway dial loop can spend — set it at key-creation time and
set it low. Walkthrough: `setup/guardrails.md` §1.

## The vault entry is install-wide

Agents default to `secretMode: all`. Once the ElevenLabs key is in the vault,
the gateway injects it into **any** group's traffic to `api.elevenlabs.io`, not
just this one. Other groups get no tools, no persona list and no phone number —
but they do have a shell, and a shell plus an injected key is enough to reach
the API.

That is an install-wide decision, so make it deliberately.
`onecli agents set-secret-mode --id <agent-id> --mode selective` narrows
injection to the agents you assign the secret to; use it if this install hosts
groups that should not be able to reach your ElevenLabs account.

## Provider status

| Provider | Status |
|---|---|
| `elevenlabs` | **implemented** — inbound `managed`, outbound, campaigns, persona management, transcripts |
| `openai` (Realtime) | **not implemented** — accepting `realtime.call.incoming` needs a public SIP webhook, which an agent container cannot host |
| `gemini` (Live) | **not implemented** — no first-party PSTN; it needs a media bridge in front of it |

The provider layer is an abstract class, so adding one is writing a subclass,
not a rewrite. Capability matrix and the "adding a provider" walkthrough:
`skills/voice-line/references/providers.md`.

## Consent and compliance

Outbound calling is regulated — TCPA in the US and local equivalents elsewhere.
ElevenLabs' own guidance:
<https://elevenlabs.io/docs/agents-platform/legal/tcpa-compliance>. Consent, the
calling list, disclosure that the caller is an AI, and calling-hours rules are
the **operator's** responsibility, not the template's and not the vendor's. The
persona states this once when a campaign is first proposed; that is a reminder,
not a compliance program.

## Teardown

1. **Revoke the key at the source.** Deleting the vault entry (`onecli secrets
   delete …`) only removes NanoClaw's copy. The key keeps working — and keeps
   being **billable** — until you revoke it in the ElevenLabs dashboard. Do that
   first.
2. Delete the agent group (`ncl groups delete <group-id>`), which takes the
   paused tasks and the workspace state with it.
3. Remove any carrier vault entry (`api.twilio.com`, `api.exotel.com` /
   `api.in.exotel.com`, or the SIP vendor's host).
4. Release the phone number at the carrier if you no longer want it — that
   account bills separately from ElevenLabs.

---

Contributed by Amit Yanay — <https://github.com/CrAzyScreamx>
