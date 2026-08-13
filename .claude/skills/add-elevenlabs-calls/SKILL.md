---
name: add-elevenlabs-calls
description: Add outbound phone calls so NanoClaw agents can ring a real person through an ElevenLabs voice agent and report back what was said. Stores the ElevenLabs API key in OneCLI, discovers the account's voice agents, phone numbers and dynamic variables, then wires the ones you pick as real MCP tools scoped to the agent groups you choose. Triggers on "add elevenlabs", "elevenlabs calls", "make phone calls", "outbound calls", "let the agent call someone", "call a customer", "voice agent", "phone my", "ring them", "add-elevenlabs-calls".
---

# Add ElevenLabs calls

Gives chosen agent groups the ability to place outbound phone calls — **as tools, not as
instructions for making HTTP calls**. A call dials a real number and puts one of the account's
ElevenLabs voice agents on the line; the persona holds the conversation, and NanoClaw's agent
reports back what was said once it ends.

Four tools ship, and each is separately selectable per group:

| Tool | What it does |
|---|---|
| `start_call` | Dials an allowlisted persona at an E.164 number with the dynamic variables it needs, and hands back a ready-to-run follow-up command |
| `get_call` | Reads the current state of one conversation. Never blocks |
| `list_conversations` | Past calls for an allowlisted persona, with optional summaries |
| `list_agents` | Live re-read of this group's personas and their current dynamic variables |

A group that gets everything except `start_call` can read call history and refresh the
directory but cannot dial — which is a reasonable place to start with a group you're unsure
about.

**Principle:** do the work — don't tell the user to do it. Only ask for what is genuinely
manual: the API key, which personas and numbers each group may use, which capabilities they
get, and which groups. Everything else — key verification, credential wiring, discovery of the
agents and their dynamic variables, per-group config, tool construction — this skill does
itself.

These calls reach real phones belonging to real people, and there is no undo. **Do not place a
test call during setup**, and do not enable a capability nobody asked for.

Every phase is idempotent — safe to re-run from the top if interrupted, and safe to re-apply
later to add a persona, a capability, or a group.

## How this is put together

Worth reading once, because it explains why the phases are ordered the way they are.

The tools come from a small stdio MCP server, `elevenlabs-mcp`, that this skill copies into
`container/agent-runner/src/elevenlabs-mcp/`. That directory is read-only-mounted into **every**
container at `/app/src` (`src/container-runner.ts`), so the code is live everywhere without an
image rebuild — but it only *runs* in groups where this skill registered it with
`ncl groups config add-mcp-server`. That registration lives in the central DB, per group.

So there are two independent gates, and they are both real:

- **Which groups** — a group with no `elevenlabs` MCP server has no calling tools at all. Not
  hidden ones, not refusing ones: none in `tools/list`.
- **Which capabilities** — the server builds its tool list from that group's
  `groups/<folder>/elevenlabs/config.json` at startup. A capability that isn't listed produces
  no tool, and a persona that isn't in that file cannot be dialed by that group.

Registering the server also exposes `mcp__elevenlabs__*` to the agent automatically —
`container/agent-runner/src/providers/claude.ts` derives `allowedTools` from the group's
`mcpServers` keys, so registration alone is what makes the tools reachable.

The per-group config is also where the **dynamic-variable snapshot** lives. At startup the
server renders each allowlisted persona, the number it dials from, and the variables it expects
into the `start_call` tool description, so the agent reads them as part of the tool rather than
from a shared file. That is deliberate: `container/skills/` is a single global read-only mount,
so a persona list written there would show every group every other group's personas.

What none of this is, is a security boundary. Read `${CLAUDE_SKILL_DIR}/caveats.md` #2 before
treating the confirm-before-dial rule as an approval gate.

## Prerequisites

**An ElevenLabs account on the Agents Platform**, with at least one agent and at least one
imported phone number (Twilio or SIP trunk). This skill wires up what is already there; it does
not create agents or buy numbers. If the user has neither, they build them in the ElevenLabs
dashboard first.

**OneCLI**, because the API key lives in the vault and nowhere else:

```bash
onecli version >/dev/null 2>&1 && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, stop and tell the user to run `/init-onecli` first. This skill has one
credential path — the vault — and nothing it writes to disk holds a key
(`${CLAUDE_SKILL_DIR}/caveats.md` #2).

**A built agent image**, since the verification steps run the server inside one:

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^nanoclaw-agent[^:]*:latest$' || echo "NO IMAGE — run ./container/build.sh"
```

## Already applied?

```bash
test -d container/agent-runner/src/elevenlabs-mcp && echo "SERVER INSTALLED" || echo "NOT INSTALLED"
ls -d groups/*/elevenlabs 2>/dev/null || echo "no groups enabled yet"
onecli secrets list | grep -i elevenlabs || echo "no vault entry yet"
```

If the server is installed and you only want to add a persona, a capability, or a group, go
straight to `${CLAUDE_SKILL_DIR}/enable.md` — but re-read what the enabled groups already have
first, since the merge in that file replaces whole top-level keys:

```bash
cat groups/*/elevenlabs/config.json 2>/dev/null
```

If a persona's prompt changed in ElevenLabs since the last run, re-run
`${CLAUDE_SKILL_DIR}/discover.md` and then `enable.md` to refresh the variable snapshot.

## Phases

Run these in order.

1. **Connect** — take the ElevenLabs API key, verify it against the account, put it in the
   OneCLI vault, and prove the gateway injects it correctly.
   **Read `${CLAUDE_SKILL_DIR}/connect.md` and follow it.**
   Ends with `XI_API_KEY` in the shell for the discovery phase, plus `IMAGE` and `NET` for the
   container probes.

2. **Install the server** — copy `elevenlabs-mcp` into the container tree and the container
   skill into `container/skills/`, then prove both build and pass their tests.
   **Read `${CLAUDE_SKILL_DIR}/install.md`.** Done once per install, regardless of how many
   groups follow.

3. **Discover** — list the account's agents and phone numbers with the dynamic variables each
   agent expects, and show the user the table.
   **Read `${CLAUDE_SKILL_DIR}/discover.md`.** This runs after install so it can import the
   already-installed variable extractor rather than reimplementing it.

4. **Enable per group** — for each group the user names: pick its personas and numbers, pick
   its capabilities, write its config, register the server, restart, verify.
   **Read `${CLAUDE_SKILL_DIR}/enable.md`.** Finish one group completely before starting the
   next; a half-enabled group is the hardest state to diagnose.

## What "enabled" means

For a group to be able to place a call, three things must be true. Any one missing is the whole
answer when something doesn't work:

| Thing | Where | Written by |
|---|---|---|
| The group runs the server | `mcp_servers.elevenlabs` in the central DB | `enable.md` step 3 |
| The group has personas and capabilities | `groups/<folder>/elevenlabs/config.json` | `enable.md` step 2 |
| The key is in the vault and matches the host | `onecli secrets list` | `connect.md` step 3 |

Plus a container restart, because MCP servers are launched at spawn.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Host-side key check returns `401` | The key is wrong, truncated, or from a different workspace. Take it again — `${CLAUDE_SKILL_DIR}/connect.md` step 1. |
| Container-side injection check returns `401` while the host check passed | The vault entry's `--value-format` or `--header-name` is wrong. ElevenLabs takes a bare key in `xi-api-key`, not a `Bearer` token. Fix with `onecli secrets update` — `${CLAUDE_SKILL_DIR}/connect.md` step 4. |
| Container-side check returns `000` or a TLS error | The container isn't reaching the gateway, or doesn't trust its CA. Check `NODE_EXTRA_CA_CERTS` inside the container and that the OneCLI gateway is up. |
| Agent says it has no calling tools | That group has no `elevenlabs` MCP server registered, or wasn't restarted after registration. Re-run `${CLAUDE_SKILL_DIR}/enable.md` steps 3–4 for it. |
| Agent has `get_call` but not `start_call` | `start_call` isn't in that group's `capabilities`. Re-run `enable.md` steps 1–2 with it selected. |
| `[elevenlabs-mcp] not enabled for this group` in the probe output | The server is registered but `config.json` is missing — step 3 of `enable.md` ran, step 2 didn't. |
| `[elevenlabs-mcp] no proxy found …` from inside a container | Nothing will inject the key and every call will 401. The group isn't being wired by OneCLI — check the gateway before enabling it. |
| `start_call` rejects a persona the user expects to work | That agent id isn't in this group's `config.json`. Re-run `enable.md` steps 1–2 and select it. |
| `start_call` rejects the dynamic variables | The persona's prompt changed since discovery. Re-run `discover.md`, then `enable.md` step 2 for every group using it. |
| A call is placed but nothing is ever reported | The follow-up task wasn't created, or was created against a mistyped conversation id. Check `ncl tasks list --group <id>` for an `el-call-…` series. |
| An `el-call-…` series keeps firing long after the call | The agent didn't cancel it. Cancel it by hand with `ncl tasks cancel --id <series-id>`; the deadline in the poll script stops it eventually. |
| The agent dials without confirming first | Prose, not a gate — `${CLAUDE_SKILL_DIR}/caveats.md` #2. If that is unacceptable for a group, drop `start_call` from its capabilities. |

## Caveats

Six structural limits. Read `${CLAUDE_SKILL_DIR}/caveats.md` in full before relying on this:

1. An in-progress call cannot be ended from here — ElevenLabs exposes no REST endpoint for it.
2. There is no approval gate on placing a call, this design cannot reach one, and group
   selection is not a network boundary — the vault key reaches every group's proxied traffic to
   `api.elevenlabs.io`.
3. The dynamic-variable snapshot is captured at install time and goes stale when a persona is
   edited.
4. The container skill is visible to every agent group, not just enabled ones.
5. Each gated poll fire spawns the group's container for a few seconds while a call is live.
6. `elevenlabs-mcp/proxy.ts` duplicates `ha-mcp/proxy.ts`, so a skill can install standalone.

## Testing

The MCP server ships with `elevenlabs-mcp.test.ts`, copied into the container tree in phase 2
and run there. It guards the claim this skill is built on — that a capability the operator did
not enable produces no tool — plus the checks that reject *before* any network call: an agent id
outside the group's allowlist, and missing dynamic variables. Those are the two ways a wrong
call reaches a real phone, so they are tested at the point where nothing has been dialed yet.
It also covers the Twilio/SIP endpoint choice, the variable extractor, the poll script's
gate/wake/timeout decisions, and the proxy recovery that credential injection depends on.

**There is no structural reach-in test, and there is nothing to write one against.** This skill
edits no tracked file: it adds two directories, registers an MCP server through
`ncl groups config add-mcp-server`, and writes a per-group `config.json`. Both of those are
runtime state in the central DB and the group workspace, so there is no source line whose
deletion a test could catch. Per `docs/skill-guidelines.md`, conformance here is anatomy —
idempotent apply, a REMOVE.md that reverses everything — plus the always-on build leg
(`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`), which is what catches core
drift in the MCP SDK types and the runner's own interfaces.

The rest of the verification is deliberately live and lives in the phases: a host-side key check
and a container-side injection check in `connect.md`, a `tools/list` smoke against a throwaway
config in `install.md`, and a per-group `tools/list` against a real container in `enable.md`.
None of them dials a phone.

## Removal

See [REMOVE.md](REMOVE.md). This skill leaves state **outside the repo** — a secret in the
OneCLI vault, a live API key in the ElevenLabs dashboard, per-group config files, per-group DB
rows, and possibly a live polling task series — so REMOVE.md reverses those too, not just the
copied files.
