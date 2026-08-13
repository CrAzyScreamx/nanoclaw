# Install the `ha-mcp` server

Done once per install, no matter how many services or groups follow. Nothing here is
per-group; the gating happens later.

## 1. Copy the server into the container tree

```bash
mkdir -p container/agent-runner/src/ha-mcp
cp .claude/skills/add-homeassistant/mcp-server/*.ts container/agent-runner/src/ha-mcp/
ls container/agent-runner/src/ha-mcp/
```

Expect six files: `config.ts`, `ha.ts`, `proxy.ts`, `rooms.ts`, `tools.ts`, `server.ts`, plus
`ha-mcp.test.ts`.

`cp` overwrites, so this is safe to re-run — and re-running is how you pick up a fix to the
server after updating the skill. It adds a new directory and touches no existing file in the
tree.

**Why here and not the Dockerfile.** `container/agent-runner/src` is read-only-mounted into
every container at `/app/src` (`src/container-runner.ts`), so the code is live the moment a
container next spawns. No image rebuild, no `pnpm`/`bun` install, no mount-allowlist entry —
and no version of the server pinned inside a stale image while the repo has moved on.

## 1b. Copy the container skill

```bash
rsync -a .claude/skills/add-homeassistant/container-skills/ container/skills/
head -5 container/skills/homeassistant/SKILL.md
```

This is the judgement layer: when to reach for the tools, the "clean my room" flow across
`vacuum_get_room` / `vacuum_list_areas` / `vacuum_remember_room`, what to ask before, and how to
report what actually happened. The tools carry their own argument documentation, so the skill
deliberately says nothing about how to call them.

Copied once regardless of how many groups follow, and safe to re-run — it reads nothing at
install time and holds no per-group values.

**This makes the skill visible to every agent group, not just enabled ones.** The default
`skills: 'all'` selection re-reads `container/skills/` at every spawn
(`src/container-runner.ts`), and there is no `ncl` verb that writes the per-group `skills`
column. That is harmless here in a way it wasn't for the old `/add-cleaner`: the skill's first
instruction is that no `mcp__homeassistant__*` tools means it isn't set up for this group, and
a group with no MCP server registration genuinely has none. The cost is a little context in
groups that don't use it, not a capability leak.

## 2. Prove it builds and passes its tests

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/ha-mcp/ha-mcp.test.ts)
```

Both must be clean before continuing. The typecheck matters more than usual here: nothing
compiles this server ahead of time — `bun` runs the TypeScript directly at spawn — so a type
error would first surface as an MCP server that fails to start inside a container, where the
logs are gone as soon as it exits.

The test file guards the claim the whole skill rests on: a capability the operator did not
enable produces no tool. It also covers config parsing, the proxy recovery gateway mode depends
on, and the room map's replace-don't-duplicate rewrite.

## 3. Smoke-test it before wiring any group

Run the server against a throwaway config and speak MCP to it directly. This proves the
handshake and — more usefully — shows you the exact tool list a given `services.json` produces,
before a real group gets it:

```bash
D=$(mktemp -d)
printf 'HA_URL=%s\nHA_AUTH=%s\n' "$HA_URL" "$AUTH_MODE" > "$D/config.env"
[ "$AUTH_MODE" = token ] && printf 'HA_TOKEN=%s\n' "$HA_TOKEN" >> "$D/config.env"
printf '{"vacuum":{"entity_id":"vacuum.placeholder","capabilities":["status","clean_area"]}}\n' > "$D/services.json"

{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1; } | HA_CONFIG_DIR="$D" bun container/agent-runner/src/ha-mcp/server.ts 2>&1 | head -3
rm -rf "$D"
```

Expect two `[ha-mcp]` log lines on stderr — a config line reporting `2 tools enabled`, and a
`network:` line — followed by the JSON-RPC `initialize` result.

The `network:` line is worth reading even though this is a throwaway: run from the host it will
say it found no proxy, which is correct here and *not* what you want to see later from inside a
real container in `gateway` mode. `enable.md` step 4 checks it in the place where it counts.

No config at all is also a valid state — the server logs `not enabled for this group` and exits
`0`. That's deliberate: a leftover registration on a de-configured group should look like "no
tools", not like a broken container.

## Carry forward

Nothing new. Go back to `SKILL.md` phase 3 and ask which services to activate.
