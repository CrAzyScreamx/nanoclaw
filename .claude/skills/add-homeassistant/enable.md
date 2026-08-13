# Enable a service for the chosen agent groups

Called at the end of `vacuum.md`, `car.md` and `printer.md`. Needs `HA_URL`, `AUTH_MODE`,
`HA_TOKEN` (in `token` mode), the service block that phase produced, and the group ids the user
picked.

Run every step for **each** chosen group before moving on to the next group — a half-enabled
group is the hardest state to diagnose.

Everything here is idempotent and merge-shaped: enabling the car for a group that already has
the vacuum keeps the vacuum.

## 1. Write the per-group config

Resolve the group's folder — the config has to land in the directory mounted into that group's
container at `/workspace/agent`:

```bash
GROUP_ID="<group-id>"
FOLDER="$(ncl groups get --id "$GROUP_ID" --json | grep -o '"folder"[^,]*' | cut -d'"' -f4)"
test -d "groups/$FOLDER" && echo "groups/$FOLDER" || echo "FOLDER NOT FOUND — re-check the group id"
mkdir -p "groups/$FOLDER/home-assistant"
```

### The connection — `config.env`

Two variants. Use the one matching `AUTH_MODE`, and rewrite it every time so a mode change
takes effect:

**`gateway`** (kept behind the credential proxy; no token on disk):

```bash
cat > "groups/$FOLDER/home-assistant/config.env" <<EOF
HA_URL=$HA_URL
HA_AUTH=gateway
EOF
```

**`token`** (bypassed from the proxy; the server sends the header itself):

```bash
cat > "groups/$FOLDER/home-assistant/config.env" <<EOF
HA_URL=$HA_URL
HA_AUTH=token
HA_TOKEN=$HA_TOKEN
EOF
chmod 600 "groups/$FOLDER/home-assistant/config.env"
```

In `token` mode, tell the user plainly, once: their Home Assistant token is now in cleartext at
`groups/<folder>/home-assistant/config.env`, once per enabled group, inside a directory mounted
read-write into that group's container. `caveats.md` #2 has the full shape of that.

### The capabilities — `services.json`

Merge the service block in rather than overwriting the file, so the other service survives:

```bash
cat > /tmp/ha-fragment.json <<'EOF'
<the vacuum or car block from the service phase>
EOF

node -e '
  const fs = require("fs");
  const [target, fragFile] = process.argv.slice(1);
  const frag = JSON.parse(fs.readFileSync(fragFile, "utf8"));
  const cur = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8").trim() || "{}") : {};
  fs.writeFileSync(target, JSON.stringify({ ...cur, ...frag }, null, 2) + "\n");
' "groups/$FOLDER/home-assistant/services.json" /tmp/ha-fragment.json

cat "groups/$FOLDER/home-assistant/services.json"
```

The merge is **top-level, by service key**: re-running the vacuum phase replaces the whole
`vacuum` block and leaves `car` and `printers` alone. That's deliberate — a deep merge would keep
capabilities the user just chose to turn off, which is the wrong direction for a permission list
to drift.

`printers` is an array, and the same rule applies to it whole: the fragment replaces the entire
list, so a second printer has to arrive in a block containing both. Check the printed file for
the count you expect.

Read the printed file before continuing. It is the exact input the server turns into tools, and
a typo here is a capability that silently doesn't appear.

## 2. Register the MCP server for the group

```bash
ncl groups config add-mcp-server \
  --id "$GROUP_ID" \
  --name homeassistant \
  --command bun \
  --args '["/app/src/ha-mcp/server.ts"]'
```

No `--env`: everything the server needs is in the group's own directory, read at startup. That
keeps the token out of `container.json`, which is mounted into the container and is not the
place for a credential.

Re-running overwrites the same key, so this is safe to repeat.

Registering the server is also what exposes the tools — `providers/claude.ts` derives
`allowedTools` from the group's `mcpServers` keys, so `mcp__homeassistant__*` is allowed
automatically. There is no allowlist to edit.

Confirm it landed:

```bash
ncl groups config get --id "$GROUP_ID" | grep -A3 homeassistant
```

**If you are running this from inside an agent container**, `ncl` write verbs are
approval-gated and this will wait for an admin. From a host operator shell it executes
immediately. The response says which path it took.

## 3. Restart the group

```bash
ncl groups restart --id "$GROUP_ID" --message "confirm your Home Assistant tools are available"
```

MCP servers are launched at container spawn, so a live container keeps its old tool set until
it's replaced. No `--rebuild` — this skill installs no packages and the image is unchanged.

`--message` is what forces an immediate respawn: `restart` alone kills the container without
bringing it back (`src/container-restart.ts`), and step 4 needs a live one now.

**If the group is idle it does nothing at all.** `restartAgentGroupContainers` filters to
sessions where `isContainerRunning(s.id)` before the loop that writes the wake message, so with
no container up it returns `{"restarted": 0}` having written nothing and woken nothing. That is
not a failure — the config is already on disk and the next spawn picks it up — but it means
step 4 has no container to exec into. Two ways forward:

- **Ask the user to message the group.** That spawns a container and doubles as step 5.
- **Verify without one**, by running the server in a throwaway container with the group's own
  config mounted at the path it expects:

  ```bash
  docker run --rm ${NET:+--network "$NET"} \
    -v "$PWD/groups/$FOLDER/home-assistant:/workspace/agent/home-assistant:ro" \
    -v "$PWD/container/agent-runner/src:/app/src:ro" \
    --entrypoint sh "$IMAGE" -lc '<the JSON-RPC block from step 4>'
  ```

  In `token` mode this is equivalent to the real thing. In `gateway` mode it is **not** — a
  throwaway has no OneCLI proxy environment, so it cannot exercise injection. There, get a real
  container.

## 4. Verify against a real container

This is the check that could not be run earlier, and in `gateway` mode it is the one that
settles whether the token is actually being injected.

```bash
CN="$(docker ps --format '{{.Names}}' | grep "^nanoclaw-v2-$FOLDER-" | head -1)"
test -n "$CN" && echo "container: $CN" || echo "no live container — re-run step 3 and wait a few seconds"
```

Speak MCP to the server the same way the agent's runtime does. Note the `env -u`: the MCP stdio
transport hands a server only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` and strips
every proxy variable, so stripping them here is what makes this test faithful rather than
flattering. It is also what proves the `/proc/1/environ` recovery in `proxy.ts` works.

```bash
docker exec "$CN" env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NODE_EXTRA_CA_CERTS \
  sh -lc '{ printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
           sleep 1; } | bun /app/src/ha-mcp/server.ts 2>&1 | head -20'
```

Read the two `[ha-mcp]` lines first:

| `config:` line | Meaning |
|---|---|
| `N tools enabled` matching what you chose | Correct. |
| `0 tools enabled` | `services.json` didn't parse or has no service block. Re-run step 1. |
| `not enabled for this group` | `config.env` is missing. Step 2 ran, step 1 didn't. |

| `network:` line | Meaning |
|---|---|
| `routing through http://… with the gateway CA` | `gateway` mode is wired correctly. |
| `routing through http://… (no CA file found)` | Proxying, but the MITM certificate isn't trusted. It may still work if the CA is in the image store; a TLS error in step 5 means it isn't. |
| `no proxy found in the container environment` **in `gateway` mode** | Nothing will inject a token and every call will 401. Either OneCLI isn't wiring this group, or this group should be on `token` mode. Fix before continuing. |
| `NO_PROXY covers <host>` **in `gateway` mode** | Something already excludes Home Assistant from the proxy. Honor that and switch this install to `token`, or remove the exclusion — don't leave it contradicting itself. |
| `direct connection (bypassed from the proxy)` | Expected and correct in `token` mode. |

Then make a real call through the server. Use a read-only tool — `vacuum_status`, `car_status`
or `printer_status` — because this is a live machine and a verification step should not move
anything:

```bash
docker exec "$CN" env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NODE_EXTRA_CA_CERTS \
  sh -lc '{ printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
           printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"vacuum_status\",\"arguments\":{}}}"
           sleep 2; } | bun /app/src/ha-mcp/server.ts 2>/dev/null | tail -1'
```

A result naming your entity with a real `state` is the end-to-end proof: container → network →
auth → Home Assistant → the right machine.

| Result | Meaning |
|---|---|
| A state payload | Done. This group works. |
| `Error: … rejected the request (401) … (no proxy found …)` | `gateway` mode with no proxy — see the `network:` table above. |
| `Error: … rejected the request (401) … (routing through …)` | The proxy is there but OneCLI isn't matching. Check `onecli secrets list` contains `HA_HOST`; fix with `onecli secrets update`. Don't re-create the secret. |
| `Error: … rejected the token (401)` | `token` mode with a bad token in `config.env` — usually a truncated paste. Re-run step 1. |
| `Error: Could not reach Home Assistant …` | Reachable from the throwaway probe but not from here. The difference is the proxy: a LAN host reached through an external proxy is exactly this shape. |

## 5. Verify from chat

Tell the user to message one of the enabled groups with a read-only question first:

> "What's the vacuum doing?" — for the car, "how much battery does the car have?" — for the
> printer, "how much ink is left?"

That exercises the whole path without moving anything. The agent should answer with a real
state, and should be using `mcp__homeassistant__vacuum_status` / `car_status` / `printer_status`
rather than describing what it would do.

For the printer specifically, the answer should name the levels *and* flag a low one. If the
agent reports a level as a bare number when the report says `low: true`, or reports a `null`
level as empty, the container skill isn't loaded for that group — check
`container/skills/homeassistant/SKILL.md` exists.

Then, if the vacuum is enabled with `room_memory` and `clean_area`, have them say **"clean my
room"** from an account whose room isn't mapped yet. The expected behavior: the agent lists the
areas by name, asks which is theirs, saves it, starts the clean — and the *next* time they say
it, doesn't ask again.

If the agent says it has no Home Assistant tools, that group's MCP server isn't registered or
the restart didn't happen — go back to steps 2 and 3.

## 6. Repeat

For the next group in this service's list, go back to step 1. When they're all done, return to
`SKILL.md` phase 4 and start the next service, if there is one.
