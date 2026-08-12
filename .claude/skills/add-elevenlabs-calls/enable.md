# Enable calling for one agent group

Needs the discovered agent values from `${CLAUDE_SKILL_DIR}/discover.md`, one group id, and
`IMAGE` / `NET` / `LIVE` from `${CLAUDE_SKILL_DIR}/connect.md`.

Run every step for **one** group before starting the next. A group with a config file and no
registration, or a registration and no config, is the hardest state to diagnose — and the
second half is the one people forget.

Everything here is idempotent and merge-shaped: re-running to change capabilities keeps the
personas, and re-running to change personas keeps the capabilities.

## 1. Pick what this group gets

Two questions, both `AskUserQuestion`, both multi-select.

**Which personas?** Offer the agents from the discovery table by name, with the number each one
dials from — one persona is a perfectly normal answer. Only the personas chosen here can be
dialed by this group; the server rejects anything else before it reaches the network.

**Which capabilities?** Offer all four, defaulting to all four:

| Capability | What it lets the group do |
|---|---|
| `start_call` | Place calls. The one with real-world consequences |
| `get_call` | Check the state of a call it placed |
| `list_conversations` | Read past calls for its allowlisted personas |
| `list_agents` | Refresh the persona list and their current variables |

Dropping `start_call` leaves a group that can read call history and nothing else — a reasonable
setting for a group that should see results without being able to dial.

## 2. Write the per-group config

Resolve the group's folder — the config has to land in the directory mounted into that group's
container at `/workspace/agent`:

```bash
GROUP_ID="<group-id>"
FOLDER="$(ncl groups get --id "$GROUP_ID" --json | grep -o '"folder"[^,]*' | cut -d'"' -f4)"
test -d "groups/$FOLDER" && echo "groups/$FOLDER" || echo "FOLDER NOT FOUND — re-check the group id"
mkdir -p "groups/$FOLDER/elevenlabs"
```

Write the fragment for what the user just chose, using the values discovery printed. The
`agent_id`, `phone_number_id`, `phone_number` and `provider` go in verbatim — `provider` is
what decides which ElevenLabs endpoint the dial uses, so a wrong value fails every call from
this group:

```bash
cat > /tmp/el-fragment.json <<'EOF'
{
  "capabilities": ["list_agents", "start_call", "get_call", "list_conversations"],
  "poll": { "recurrence": "*/2 * * * *", "deadline_minutes": 30 },
  "agents": [
    {
      "agent_id": "agent_01xyz", "name": "Reception",
      "phone_number_id": "phnum_01abc", "phone_number": "+972521234567", "provider": "twilio",
      "dynamic_variables": [
        { "name": "customer_name", "used_in": ["first_message"] },
        { "name": "order_id", "used_in": ["system_prompt"] }
      ]
    }
  ]
}
EOF

node -e '
  const fs = require("fs");
  const [target, fragFile] = process.argv.slice(1);
  const frag = JSON.parse(fs.readFileSync(fragFile, "utf8"));
  const cur = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8").trim() || "{}") : {};
  fs.writeFileSync(target, JSON.stringify({ ...cur, ...frag }, null, 2) + "\n");
' "groups/$FOLDER/elevenlabs/config.json" /tmp/el-fragment.json

cat "groups/$FOLDER/elevenlabs/config.json"
rm -f /tmp/el-fragment.json
```

The merge is **top-level, by key**: a fragment carrying only `capabilities` changes the
capabilities and leaves the personas alone. `agents` is an array and the same rule applies to it
whole — the fragment replaces the entire list, so **adding a second persona means emitting a
fragment containing both**. Check the printed file for the count you expect.

That is deliberate rather than a deep merge: a deep merge would keep personas and capabilities
the user had just chosen to remove, which is the wrong direction for a permission list to drift.

`poll` is optional and the values above are the defaults — every two minutes, giving up after
30 minutes. Raise `deadline_minutes` only for personas that hold genuinely long conversations;
each fire spawns the container for a few seconds (`${CLAUDE_SKILL_DIR}/caveats.md` #5).

Read the printed file before continuing. It is the exact input the server turns into tools, and
a typo in an id is a persona that silently can't be dialed.

## 3. Register the MCP server for the group

```bash
ncl groups config add-mcp-server \
  --id "$GROUP_ID" \
  --name elevenlabs \
  --command bun \
  --args '["/app/src/elevenlabs-mcp/server.ts"]'
```

Everything the server needs is in the group's own directory, read at startup, and the API key
comes from the gateway at request time — so nothing about this registration carries a
credential, and `container.json` (which is mounted into the container) stays free of one.

Re-running overwrites the same key, so this is safe to repeat.

Registering the server is also what exposes the tools: `providers/claude.ts` derives
`allowedTools` from the group's `mcpServers` keys, so `mcp__elevenlabs__*` becomes reachable as
a consequence of this command.

Confirm it landed:

```bash
ncl groups config get --id "$GROUP_ID" | grep -A3 elevenlabs
```

**If you are running this from inside an agent container**, `ncl` write verbs are
approval-gated and this will wait for an admin. From a host operator shell it executes
immediately. The response says which path it took.

## 4. Restart the group

```bash
ncl groups restart --id "$GROUP_ID" --message "confirm your ElevenLabs call tools are available"
```

MCP servers are launched at container spawn, so a live container keeps its old tool set until
it is replaced. No `--rebuild`: the image is unchanged.

`--message` is what forces an immediate respawn — `restart` alone kills the container without
bringing it back (`src/container-restart.ts`), and step 5 needs a live one now.

**If the group is idle it does nothing at all.** `restartAgentGroupContainers` filters to
sessions where `isContainerRunning(s.id)` before the loop that writes the wake message, so with
no container up it returns `{"restarted": 0}` having written nothing and woken nothing. That is
not a failure — the config is on disk and the next spawn picks it up — but it leaves step 5 with
no container to exec into. Two ways forward:

- **Ask the user to message the group.** That spawns a container and doubles as step 6.
- **Probe with a throwaway container**, mounting the group's own config at the path the server
  expects. This exercises the tool list, which is what step 5 reads, without needing the
  gateway:

  ```bash
  docker run --rm ${NET:+--network "$NET"} \
    -v "$PWD/groups/$FOLDER/elevenlabs:/workspace/agent/elevenlabs:ro" \
    -v "$PWD/container/agent-runner/src:/app/src:ro" \
    --entrypoint sh "$IMAGE" -lc '
      { printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}"
        printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
        printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
        sleep 1; } | bun /app/src/elevenlabs-mcp/server.ts 2>&1 | head -20'
  ```

  A throwaway has no OneCLI proxy environment, so it proves the tool list and not the
  credential path. `connect.md` step 4 already settled the credential path for this install.

## 5. Verify against a real container

```bash
CN="$(docker ps --format '{{.Names}}' | grep "^nanoclaw-v2-$FOLDER-" | head -1)"
test -n "$CN" && echo "container: $CN" || echo "no live container — see step 4"
```

Speak MCP to the server the way the agent's runtime does. The `env -u` matters: the MCP stdio
transport hands a server only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` and strips every
proxy variable, so stripping them here is what makes this test faithful rather than flattering.
It is also what proves the `/proc/1/environ` recovery in `proxy.ts` works:

```bash
docker exec "$CN" env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NODE_EXTRA_CA_CERTS \
  sh -lc '{ printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
           sleep 1; } | bun /app/src/elevenlabs-mcp/server.ts 2>&1 | head -20'
```

Read the `[elevenlabs-mcp]` lines first:

| Startup line | Meaning |
|---|---|
| a config line whose tool count matches what you chose | Correct. |
| `not enabled for this group` | `config.json` is missing. Step 3 ran, step 2 didn't. |
| `routing through http://… with the gateway CA` | The credential path is wired. |
| `routing through http://… (no CA file found)` | Proxying, but the MITM certificate isn't in a file it could read. It may still work if the CA is in the image store; a TLS error on the first real call means it isn't. |
| `no proxy found in the environment` | Nothing will inject the key and every call will 401. OneCLI isn't wiring this group — fix that before the group is used. |
| `NO_PROXY covers api.elevenlabs.io` | Something excludes ElevenLabs from the proxy, so the key can never be injected. Remove the exclusion. |

Then read the `tools/list` result. It must contain exactly the capabilities chosen in step 1 —
and if `start_call` was **not** chosen, it must be absent rather than present. Check the
`start_call` description carries this group's personas and their variables, because that snapshot
is what the agent reads before every dial.

**Do not make a `tools/call` to `start_call` here.** There is no dry-run: it dials. The
read-only tools are the safe way to exercise the credential path if you want one —
`list_agents` returns this group's personas straight from ElevenLabs, and a `401` from it is the
same `401` a dial would get.

## 6. Verify from chat

Tell the user to message the enabled group with a read-only question first:

> "Which numbers can you call from?"

The agent should answer from `mcp__elevenlabs__start_call`'s description or by running
`list_agents` — naming the personas and their numbers — rather than describing what it would do.
If it says it has no calling tools, that group's server isn't registered or the restart didn't
happen; go back to steps 3 and 4.

Then, when the user has a real call they actually want made, watch the first one:

- The agent should **state who, which number, which persona and which variables, and wait for a
  yes** before dialing. That confirmation is prose, not a gate (`${CLAUDE_SKILL_DIR}/caveats.md`
  #2) — if it doesn't happen, that group should not have `start_call`.
- After the dial it should say the call has started and stop, not poll in the same turn.
- When the call ends the agent wakes from an `el-call-…` task, sends a summary, and cancels the
  series. Confirm the series is gone afterwards:

  ```bash
  ncl tasks list --group "$GROUP_ID"
  ```

  A lingering `el-call-…` series means the agent didn't cancel it; the deadline stops it, but
  cancel it by hand with `ncl tasks cancel --id <series-id>` and mention it — it usually means
  the wake prompt didn't reach a turn that could act.

## 7. Repeat

For the next group, go back to step 1. When they are all done, tell the user which groups can
dial which personas, and point them at `${CLAUDE_SKILL_DIR}/caveats.md`.
