# Install the `elevenlabs-mcp` server

Done once per install, no matter how many groups follow. Nothing here is per-group; the gating
happens in `enable.md`.

## 1. Copy the server into the container tree

```bash
mkdir -p container/agent-runner/src/elevenlabs-mcp/tools
cp .claude/skills/add-elevenlabs-calls/mcp-server/*.ts container/agent-runner/src/elevenlabs-mcp/
cp .claude/skills/add-elevenlabs-calls/mcp-server/tools/*.ts container/agent-runner/src/elevenlabs-mcp/tools/
ls container/agent-runner/src/elevenlabs-mcp container/agent-runner/src/elevenlabs-mcp/tools
```

Expect at the top level: `proxy.ts`, `config.ts`, `variables.ts`, `api.ts`, `server.ts`,
`poll.ts`, `discover.ts`, `elevenlabs-mcp.test.ts` — and under `tools/`: `index.ts`, `calls.ts`,
`directory.ts`, `describe.ts`.

`cp` overwrites, so this is safe to re-run — and re-running is how you pick up a fix to the
server after updating the skill. It adds a new directory and touches no existing file in the
tree.

**Why here and not the Dockerfile.** `container/agent-runner/src` is read-only-mounted into
every container at `/app/src` (`src/container-runner.ts`), so the code is live the moment a
container next spawns. No image rebuild and no dependency install: the server's only import
outside Node built-ins is `@modelcontextprotocol/sdk`, which is already in
`container/agent-runner/package.json`.

## 2. Copy the container skill

```bash
rsync -a .claude/skills/add-elevenlabs-calls/container-skills/ container/skills/
ls container/skills/elevenlabs-calls container/skills/elevenlabs-calls/references
```

Expect `SKILL.md` plus `references/placing-a-call.md`, `references/call-results.md`,
`references/call-history.md`.

This is the judgement layer: confirming before every dial, never re-dialing because a poll was
slow, how to summarize a finished call and where to send it. The tools carry their own argument
documentation and the per-group persona list, so the skill deliberately carries neither.

**This makes the skill visible to every agent group, not just enabled ones.** The default
`skills: 'all'` selection re-reads `container/skills/` at every spawn
(`src/container-runner.ts`), and there is no `ncl` verb that writes the per-group `skills`
column. It is harmless: the skill's first instruction is that no `mcp__elevenlabs__*` tools
means it isn't set up for this group, and a group with no MCP server registration genuinely has
none. The cost is a little context in groups that don't call anyone —
`${CLAUDE_SKILL_DIR}/caveats.md` #4.

## 3. Prove it builds and passes its tests

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/elevenlabs-mcp/elevenlabs-mcp.test.ts)
```

Both must be clean before continuing. The typecheck matters more than usual here: nothing
compiles this server ahead of time — `bun` runs the TypeScript directly at spawn — so a type
error would first surface as an MCP server that fails to start inside a container, where the
logs are gone as soon as it exits.

The test file guards the claim the whole skill rests on — a capability the operator did not
enable produces no tool — plus the two rejections that happen before any network call: an agent
outside the group's allowlist, and missing dynamic variables.

## 4. Smoke-test it before wiring any group

Run the server against a throwaway config and speak MCP to it directly. This proves the
handshake and — more usefully — shows you the exact tool list a given `config.json` produces,
before a real group gets it. `EL_CONFIG_DIR` is what points the server at the throwaway instead
of the group path it expects in a container:

```bash
D=$(mktemp -d)
cat > "$D/config.json" <<'EOF'
{
  "capabilities": ["list_agents", "get_call"],
  "agents": [
    {
      "agent_id": "agent_smoke", "name": "Smoke Test",
      "phone_number_id": "phnum_smoke", "phone_number": "+10000000000", "provider": "twilio",
      "dynamic_variables": [{ "name": "customer_name", "used_in": ["first_message"] }]
    }
  ]
}
EOF

{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1; } | EL_CONFIG_DIR="$D" bun container/agent-runner/src/elevenlabs-mcp/server.ts 2>&1 | head -20
rm -rf "$D"
```

Read three things out of the output:

- The `[elevenlabs-mcp]` startup lines on stderr — a `config:` line reporting the agent and tool
  counts, a `network:` line, and a `ready:` line naming the tools. Run from the host, the
  `network:` line reports no proxy, which is correct here and *not* what you want to see later
  from inside a real container; `enable.md` step 5 checks it where it counts.
- The `tools/list` result contains `list_agents` and `get_call` and **does not contain
  `start_call`**. That is the gating claim, and this config omitting `start_call` is what makes
  it visible by hand as well as in the test suite.
- The `list_agents` description carries `Smoke Test` and `customer_name` — that is the
  per-group snapshot being rendered from the config rather than from anything shared.

No config at all is also a valid state — the server logs `not enabled for this group` and exits
`0`. That's deliberate: a leftover registration on a de-configured group should look like "no
tools", not like a broken container.

## Carry forward

Nothing new. `XI_API_KEY`, `IMAGE`, `NET` and `LIVE` carry on unchanged into
`${CLAUDE_SKILL_DIR}/discover.md`.
