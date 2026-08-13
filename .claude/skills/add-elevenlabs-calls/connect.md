# Connect to ElevenLabs

Ends with the values every later phase needs:

- `XI_API_KEY` — the ElevenLabs API key, **in the shell only**. Never written into the repo,
  never printed, never passed to a container.
- `IMAGE` and `NET` — how to run a check inside a container.

The key has two separate jobs, and they take different paths, which is why both are checked
here:

- **On the host**, during discovery, the raw key in this shell talks to `api.elevenlabs.io`
  directly. The host does not go through the credential proxy.
- **In a container**, the agent's MCP server sends **no key at all**. The OneCLI gateway
  injects it into the outbound request. That is the path every real call takes, and step 4 is
  what proves it works before any group depends on it.

## 1. Take the key

Ask the user to create one:

> In the ElevenLabs dashboard, open your profile menu → **API Keys** → **Create API Key**. Name
> it `nanoclaw`. Give it access to the Agents Platform. Copy it — ElevenLabs shows it once.

The key inherits whatever the workspace allows, so suggest they create it under an account
whose access they're comfortable giving an agent, and — if their plan offers scoped keys — scope
it to conversational AI rather than the whole workspace.

Take it into a shell variable without echoing it back into the conversation:

```bash
read -r -s XI_API_KEY
export XI_API_KEY
```

`export` matters: the discovery script in phase 3 reads it from the environment.

## 2. Verify it against the account

One read-only call, on the host, listing the account's voice agents:

```bash
curl -sS -o /tmp/el-agents.json -w '%{http_code}\n' --max-time 20 \
  -H "xi-api-key: $XI_API_KEY" \
  https://api.elevenlabs.io/v1/convai/agents
```

| Result | Meaning |
|---|---|
| `200` | **Success.** The key works and the account has the Agents Platform. Continue. |
| `401` | The key is wrong, truncated, or pasted with stray whitespace. Take it again — step 1. |
| `403` | The key is valid but not permitted on this endpoint. The user needs a key with Agents Platform access. |
| `404` | This account isn't on the Agents Platform. Stop — there is nothing for this skill to wire. |

Check there is at least one agent before going further, and that at least one phone number is
imported — a persona with no number cannot dial:

```bash
grep -c '"agent_id"' /tmp/el-agents.json
curl -sS --max-time 20 -H "xi-api-key: $XI_API_KEY" \
  https://api.elevenlabs.io/v1/convai/phone-numbers | grep -c '"phone_number_id"'
rm -f /tmp/el-agents.json
```

Zero agents or zero numbers means the user has to build them in the ElevenLabs dashboard first.
Say which of the two is missing and stop; the later phases have nothing to offer.

## 3. Put the key in the vault

The gateway matches its host pattern against the outbound request the container makes, so the
pattern is `api.elevenlabs.io`.

Check whether one already exists before creating a duplicate — two entries matching the same
host is a state where fixing the wrong one looks like the fix not working:

```bash
onecli secrets list | grep -i elevenlabs
```

If absent, create it:

```bash
onecli secrets create \
  --name "ElevenLabs" \
  --type generic \
  --value "$XI_API_KEY" \
  --host-pattern "api.elevenlabs.io" \
  --header-name "xi-api-key" \
  --value-format "{value}"
```

`--value-format "{value}"` is the bare key with no prefix. ElevenLabs authenticates on an
`xi-api-key` header holding the key itself — a `Bearer {value}` format, which most APIs want,
sends a header ElevenLabs rejects.

Verify it landed:

```bash
onecli secrets list | grep -i elevenlabs
```

## 4. Prove the gateway injects it

**Do not skip this.** The bare `{value}` format is the one thing in this skill not proven
against a live gateway anywhere else, and a wrong format fails as a `401` from inside an agent
container much later, where it reads as "the key is bad" rather than "the header shape is
wrong".

Resolve the image and network the same way a real agent container gets them:

```bash
LIVE="$(docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | head -1)"
if [ -n "$LIVE" ]; then
  IMAGE="$(docker inspect -f '{{.Config.Image}}' "$LIVE")"
  NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$LIVE" | awk '{print $1}')"
else
  IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^nanoclaw-agent[^:]*:latest$' | head -1)"
fi
printf 'LIVE=%s\nIMAGE=%s\nNET=%s\n' "${LIVE:-<none>}" "$IMAGE" "${NET:-<default>}"
```

The check has to run inside a **live agent container**, because that is the only place with the
proxy environment and the gateway CA. A throwaway `docker run` has neither, and under egress
lockdown it has no route out at all.

If `LIVE` is empty, ask the user to send any message to one of their groups — that spawns a
container — then re-run the block above.

Now make the same read-only agents call from inside it, sending **no key**:

```bash
docker exec "$LIVE" sh -lc '
  curl -sS -o /dev/null -w "%{http_code}\n" --max-time 20 \
    ${NODE_EXTRA_CA_CERTS:+--cacert "$NODE_EXTRA_CA_CERTS"} \
    https://api.elevenlabs.io/v1/convai/agents'
```

| Result | Meaning |
|---|---|
| `200` | **The gateway is injecting the key correctly.** This is the whole point of the step: the container sent no credential and ElevenLabs still answered. Continue. |
| `401` | The secret exists but its header or format is wrong. Fix it in place rather than re-creating it: `onecli secrets update --id <id> --header-name "xi-api-key" --value-format "{value}"`, then re-run this check. |
| `000` with a TLS error | The container doesn't trust the gateway's MITM certificate. Check `NODE_EXTRA_CA_CERTS` is set inside the container and points at a readable file. |
| `000` with no output | No route to the gateway. Confirm the OneCLI gateway container is running before continuing. |

Do not continue until this returns `200`. Every group enabled after this depends on it, and the
failure surfaces later as an agent that can list nothing and dial nothing.

## Carry forward

`XI_API_KEY` (shell only), `IMAGE`, `NET`, and `LIVE` go into `${CLAUDE_SKILL_DIR}/install.md`,
`discover.md`, and `enable.md`. Keep this shell for the rest of the run — the discovery phase
needs the key again, and taking it twice means asking the user twice.
