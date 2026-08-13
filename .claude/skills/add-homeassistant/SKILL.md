---
name: add-homeassistant
description: Add Home Assistant control so NanoClaw agents can drive things in the house. Connects to Home Assistant, stores the API token in OneCLI or a per-group file, then wires the services you pick — a Dreame robot vacuum, a BYD vehicle, a network printer's status and ink levels — as real MCP tools scoped to the agent groups you choose. Triggers on "add home assistant", "home assistant", "add cleaner", "add vacuum", "robot vacuum", "dreame", "clean my room", "byd", "add car", "car AC", "printer status", "ink level", "toner level", "is the printer online", "add-homeassistant".
---

# Add Home Assistant

Gives chosen agent groups the ability to operate things in the house through Home Assistant —
**as tools, not as instructions for making HTTP calls**. Each service you enable becomes a set
of MCP tools with typed arguments; a capability you don't enable produces no tool at all, so
it is absent from the agent's tool list rather than present and refusing.

Three services ship today:

| Service | What it drives |
|---|---|
| **Dreame Cleaner** | A robot vacuum: clean a room, clean everywhere, stop / pause / dock / locate, set cleaning mode and suction, and remember which room belongs to which person |
| **BYD Vehicle** | A car: the controls you pick (AC, locks, …) and the readings you pick (battery, charge state, location, …) |
| **Printer** | One or more network printers, read-mostly: status and stop reason, ink or toner levels with a low flag, page counters, and — if there is anything to operate, usually a smart plug — power |

The printer is the odd one out and it is worth knowing why before you offer it: Home Assistant
exposes printer *sensors*, not a way to print. No integration has a `print` service and none
exposes the job queue, so this service answers "how much ink is left", "is it online" and "why
won't it print" — and nothing else. Enabling it does not give an agent a way to put a document
on paper.

**Principle:** do the work — don't tell the user to do it. Only ask for what is genuinely
manual: the Home Assistant URL, the access token, whether that URL bypasses the credential
proxy, which entity is the right machine, confirmation that the machine physically responded,
which capabilities to enable, and which agent groups get them. Everything else — reachability
testing, entity discovery, credential wiring, per-group config, tool construction — this skill
does itself.

These are physical machines in someone's home. A vacuum is loud and runs for a long time; a car
may be parked in public with someone in it. Never operate one during setup without asking
first, and never enable a capability nobody asked for.

Every phase is idempotent — safe to re-run from the top if interrupted, and safe to re-apply
later to add a service, a capability, or a group.

## How this is put together

Worth reading once, because it explains why the phases are ordered the way they are.

The tools come from a small stdio MCP server, `ha-mcp`, that this skill copies into
`container/agent-runner/src/ha-mcp/`. That directory is read-only-mounted into **every**
container at `/app/src` (`src/container-runner.ts`), so the code is live everywhere without an
image rebuild — but it only *runs* in groups where this skill registered it with
`ncl groups config add-mcp-server`. That registration lives in the central DB, per group.

So there are two independent gates, and they are both real:

- **Which groups** — a group with no `homeassistant` MCP server has no Home Assistant tools at
  all. Not hidden ones, not refusing ones: none in `tools/list`.
- **Which capabilities** — the server builds its tool list from that group's `services.json`
  at startup. A capability that isn't listed produces no tool.

Registering the server also exposes `mcp__homeassistant__*` to the agent automatically —
`container/agent-runner/src/providers/claude.ts` derives `allowedTools` from the group's
`mcpServers` keys, so no allowlist edit is needed.

What this is *not* is a security boundary. Read `${CLAUDE_SKILL_DIR}/caveats.md` #1 before
treating group selection as one.

## Prerequisites

```bash
docker ps --format '{{.Names}}' | grep -c '^nanoclaw-v2-' || true
```

```bash
grep -E '^NANOCLAW_EGRESS_LOCKDOWN=true' .env
grep -E 'NANOCLAW_EGRESS_LOCKDOWN=true' \
  "$HOME/.config/systemd/user/"*.service "$HOME/.config/systemd/user/"*.service.d/*.conf 2>/dev/null
```

If either matches, the agent network runs `--internal` and containers cannot reach a LAN Home
Assistant at all. **Stop and tell the user**: they must set `NANOCLAW_EGRESS_LOCKDOWN=false`
(accepting the wider egress surface) before this skill can do anything.

OneCLI is needed only if the user chooses to keep the token in the vault, which is the default
path. Check it now so the question in phase 1 is an honest one:

```bash
onecli version >/dev/null 2>&1 && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, say so when you ask the proxy question in phase 1 — the vault option is
unavailable until they run `/init-onecli`, leaving the per-group file as the only choice.

## Already applied?

```bash
test -d container/agent-runner/src/ha-mcp && echo "SERVER INSTALLED" || echo "NOT INSTALLED"
ls -d groups/*/home-assistant 2>/dev/null || echo "no groups enabled yet"
```

If the server is installed and you only want to add a service, a capability, or a group, you
can go straight to the relevant service phase — but re-read the connection values first, since
every later phase needs them:

```bash
sed -n 's/^HA_URL=//p;s/^HA_AUTH=//p' groups/*/home-assistant/config.env 2>/dev/null | sort -u
```

## Upgrading from `/add-cleaner`

This skill replaces `/add-cleaner`, which drove the vacuum by telling the agent how to make
`curl` calls. It uses the same per-group directory, so **the room map carries over untouched** —
`groups/<folder>/home-assistant/rooms.tsv` has the same `sender<TAB>area_id<TAB>area_name`
format the server reads, and nothing here rewrites it.

What changes: `config.env` loses `HA_ENTITY` (it moves into `services.json`) and gains nothing
else, and `container/skills/cleaner` is replaced by `container/skills/homeassistant`. Check for
the old one and remove it — leaving it in place gives every group a second, conflicting set of
vacuum instructions telling the agent to `curl`:

```bash
test -d container/skills/cleaner && echo "OLD SKILL PRESENT — rm -rf container/skills/cleaner after this skill's phase 2"
```

Re-run the connect phase normally. An existing OneCLI `Home Assistant` secret is reused rather
than duplicated.

## Phases

Run these in order.

1. **Connect** — get the Home Assistant URL, prove a container can reach it, take the access
   token, and decide whether that URL is bypassed from the credential proxy.
   **Read `${CLAUDE_SKILL_DIR}/connect.md` and follow it.**
   Ends with `HA_URL`, `HA_HOST`, `AUTH_MODE` (`gateway` or `token`), `HA_TOKEN` in the shell,
   and the `IMAGE` / `NET` / `hac` helper the service phases use.

2. **Install the server** — copy `ha-mcp` into the container tree and prove it builds and
   passes its tests. **Read `${CLAUDE_SKILL_DIR}/install.md`.** Done once per install,
   regardless of how many services or groups follow.

3. **Pick services** — ask the user which of the three services to activate. Offer all of them,
   take any subset, and say that adding another later is just a re-run of this skill.

4. **Activate each chosen service, one at a time.** Finish one completely — including its
   groups and its from-chat verification — before starting the next. Each service phase ends
   by handing off to `${CLAUDE_SKILL_DIR}/enable.md`, which merges into any config already
   there rather than replacing it.

   - **Dreame Cleaner** → `${CLAUDE_SKILL_DIR}/vacuum.md`
   - **BYD Vehicle** → `${CLAUDE_SKILL_DIR}/car.md`
   - **Printer** → `${CLAUDE_SKILL_DIR}/printer.md`

## What "enabled" means

For a group to have a capability, three things must be true. Any one missing is the whole
answer when something doesn't work:

| Thing | Where | Written by |
|---|---|---|
| The group runs the server | `mcp_servers.homeassistant` in the central DB | `enable.md` step 2 |
| The group can connect | `groups/<folder>/home-assistant/config.env` | `enable.md` step 1 |
| The capability is on | `groups/<folder>/home-assistant/services.json` | `enable.md` step 1 |

Plus a container restart, because MCP servers are launched at spawn.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Reachability test returns `401` | **This is success.** Home Assistant is reachable and answering; `401` is what `/api/` returns without a token. Continue. |
| Reachability test returns `000` from a container but the URL works in a browser | The container cannot resolve or route to that host — a `.local`/mDNS name, split-horizon DNS, or `localhost` (which inside a container means the container). See `${CLAUDE_SKILL_DIR}/connect.md`, "When the container can't reach it". |
| Reachability test returns `404` | Something answered but it isn't Home Assistant's API — usually a reverse proxy pointed at the wrong backend, or a URL with a leftover UI path. Re-check the URL. |
| Agent says it has no Home Assistant tools | That group has no `homeassistant` MCP server registered, or wasn't restarted after registration. Re-run `${CLAUDE_SKILL_DIR}/enable.md` steps 2–3 for it. |
| Agent has *some* tools but not the one you expect | That capability isn't in the group's `services.json`. Re-run the service phase and pick it. |
| `[ha-mcp] not enabled for this group` in the logs | The server is registered but `config.env` is missing — step 2 of `enable.md` ran, step 1 didn't. |
| `[ha-mcp] network: no proxy found …` while `AUTH_MODE=gateway` | The container has no `HTTPS_PROXY`, so nothing injects a token and every call will 401. Either OneCLI isn't wiring this group, or the group should be on `token` mode instead. See `${CLAUDE_SKILL_DIR}/caveats.md` #2. |
| Every call returns `401` in `gateway` mode | The OneCLI host-pattern doesn't cover the hostname the container calls. Check `onecli secrets list`; it must contain `HA_HOST`. Fix with `onecli secrets update`. |
| Every call returns `401` in `token` mode | The token in `config.env` is wrong, truncated, or was revoked in Home Assistant. Re-run `${CLAUDE_SKILL_DIR}/connect.md` step 3 and `enable.md` step 1. |
| `curl: (60)` / TLS error from the container | Home Assistant is on HTTPS with a certificate the container doesn't trust. See `${CLAUDE_SKILL_DIR}/connect.md`, "Self-signed certificates". |
| Locate ping returns `200` but the user heard nothing | `200` only means Home Assistant accepted the call. See `${CLAUDE_SKILL_DIR}/vacuum.md`, "When the ping is silent". |
| `vacuum_clean_area` fails while `vacuum_control` works | The integration wants a different shape for the area list. This is fixable without touching code — see `${CLAUDE_SKILL_DIR}/caveats.md` #3. |
| Agent cleans the wrong room for someone | Their saved room is stale, or their platform identity changed. See `${CLAUDE_SKILL_DIR}/caveats.md` #4. |
| Every printer reading is `unavailable` | Almost always the printer asleep, not a wiring fault — most network printers drop off in deep sleep and reappear when a job arrives. Check again after printing something. |
| An ink level comes back `null` with a note instead of a number | The printer doesn't measure that supply. IPP allows `-1`/`-2`/`-3` for "no level reported" and the server refuses to render those as a percentage — see `${CLAUDE_SKILL_DIR}/printer.md` step 3. |
| A supply has a level but no `low` flag | Neither the printer (`marker_low_level`) nor `services.json` (`low_threshold`) names a threshold, so there is no line to be under. Set `low_threshold` if you want one. |
| Printer discovery returns `400` … `Type is not JSON serializable` | A template read an attribute some entity in the loop doesn't have. Add `\| default(none)` — `${CLAUDE_SKILL_DIR}/printer.md` step 2. |
| Adding a second printer made the first one vanish | `printers` is an array and the merge replaces it whole. Re-run the phase emitting **both** entries. |
| Agent is asked to print and says it can't | Correct, and not a fault to fix here — Home Assistant has no print service, so this one only reads the printer. |

## Caveats

Five structural limits. Read `${CLAUDE_SKILL_DIR}/caveats.md` in full before relying on this:

1. Group and capability selection shape what the agent *can be asked to do* — they are not a
   network boundary, and in `gateway` mode the vault token reaches every agent's proxied
   traffic to that host.
2. `gateway` mode depends on recovering the proxy from `/proc/1/environ`, because the MCP
   transport strips it.
3. `vacuum.clean_area` is an integration service, not core Home Assistant — its argument shape
   is not guaranteed across integrations or versions.
4. The room map is keyed on the platform identity string, which is neither permanent nor an
   authorization check.
5. There is no approval gate on operating a machine, and this design cannot reach one.

## Testing

The MCP server ships with `ha-mcp.test.ts`, copied into the container tree in phase 2 and run
there. It guards the claim this skill is built on — that a capability the operator did not
enable produces no tool — plus config parsing, the proxy recovery that gateway mode depends
on, the room map's replace-don't-duplicate rewrite, and the printer report's two ways of lying
(rendering an unknown-level sentinel as `-1%` of ink, and claiming `low` against a threshold
nobody set). Those are the places a silent wrong answer is possible; the rest of the server is
HTTP calls whose failures are loud.

The remaining verification is deliberately physical and lives in the phases: a container-side
reachability probe in phase 1, a locate ping in `vacuum.md` and an AC test in `car.md` that the
user confirms with their own eyes and ears, a readings-against-the-printer's-own-panel check in
`printer.md` (there is nothing on a printer this skill can make move), and a from-chat check at
the end of `enable.md`.

## Removal

See [REMOVE.md](REMOVE.md). Like `/add-printers`, this skill leaves state **outside the repo**
— a OneCLI secret, a token inside Home Assistant, per-group config files, and per-group DB rows
— so REMOVE.md reverses those too, not just the copied files.
