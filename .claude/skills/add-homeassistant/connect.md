# Connect to Home Assistant

Ends with the values every later phase needs. Write them down as you go:

- `HA_URL` — how a **container** reaches Home Assistant. This is the only URL that matters:
  the MCP server runs in a container, and so do the setup probes below.
- `HA_HOST` — hostname only, no scheme and no port, derived from `HA_URL`.
- `AUTH_MODE` — `gateway` or `token`, from the proxy question in step 4.
- `HA_TOKEN` — the access token, in the shell only. Never written into the repo, never printed.
- `IMAGE`, `NET`, and the `hac` helper — how to run a check from inside a container.

Unlike a host-side setup, there is no second host URL to chase here. Everything that talks to
Home Assistant during setup runs in a container on the container's network, which is also where
the agent will run — so what you prove here is what the agent gets.

## 1. Ask for the URL

Ask the user for their Home Assistant URL, exactly as they reach it, including scheme and port.
Examples worth showing: `https://ha.example.lan:8123`, `http://192.168.1.50:8123`,
`https://abcdef.ui.nabu.casa`.

Two things to say while asking, because both change the outcome:

- **Containers, not your browser, have to reach it.** A URL that works in the user's browser
  can be unreachable from a container — that's what step 2 tests, and it's the single most
  common failure here.
- **`localhost` will not work.** Inside a container `localhost` is the container itself. If
  Home Assistant runs on this same host, the user should give the LAN IP or hostname.

Normalize what they give you — strip any trailing slash, and strip a trailing `/lovelace`,
`/dashboard`, or similar UI path if they pasted one from a browser address bar:

```bash
HA_URL="https://ha.example.lan:8123"     # <- the user's answer, normalized
HA_URL="${HA_URL%/}"
HA_HOST="$(printf '%s' "$HA_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
export HA_URL
printf 'url:  %s\nhost: %s\n' "$HA_URL" "$HA_HOST"
```

`export` matters: the `hac` helper in step 2 hands `HA_URL` to a container with `-e HA_URL`,
which forwards the value only if it is exported. Without it every probe silently requests
`/api/` against an empty base URL.

Check `HA_HOST` looks like a bare hostname or IP before continuing.

## 2. Prove a container can reach it

Resolve the image and network the same way a real agent container gets them. Prefer reading
them off a live agent container, which is ground truth:

```bash
LIVE="$(docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | head -1)"
if [ -n "$LIVE" ]; then
  IMAGE="$(docker inspect -f '{{.Config.Image}}' "$LIVE")"
  NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$LIVE" | awk '{print $1}')"
else
  IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^nanoclaw-agent[^:]*:latest$' | head -1)"
  NET="$(grep -E '^NANOCLAW_NETWORK=' .env 2>/dev/null | cut -d= -f2-)"
fi
printf 'IMAGE=%s\nNET=%s\n' "$IMAGE" "${NET:-<default bridge>}"
```

If `IMAGE` is empty, no agent image has been built yet — run `./container/build.sh` first.

Now define the helper the rest of this skill uses to talk to Home Assistant from a container,
and probe. No credentials are involved yet: `/api/` answers `401` without a token, and `401` is
exactly the result that proves reachability.

```bash
hac() { docker run --rm ${NET:+--network "$NET"} -e HA_URL -e HA_TOKEN --entrypoint sh "$IMAGE" -lc "$1"; }

C=$(hac 'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$HA_URL/api/"' 2>/dev/null)
echo "container: ${C:-000}"
```

`hac` takes a **single-quoted** script and forwards `HA_URL` / `HA_TOKEN` through `-e`, so the
variables expand inside the container rather than being pasted into the command line. That
keeps the token out of `ps` output and out of this conversation's transcript, and it is why
every `hac` call below is single-quoted.

Two more helpers, for the authenticated calls the service phases make. Define them now:

```bash
haget() {  # haget <api-path>              e.g. haget /states/vacuum.x
  docker run --rm ${NET:+--network "$NET"} -e HA_URL -e HA_TOKEN --entrypoint sh "$IMAGE" -lc \
    'curl -sS -w "\n%{http_code}\n" --max-time 20 -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api$1"' _ "$1"
}

hapost() { # hapost <api-path> <json-body>  e.g. hapost /services/vacuum/locate '{"entity_id":"vacuum.x"}'
  printf '%s' "$2" > /tmp/ha-body.json
  docker run --rm ${NET:+--network "$NET"} -e HA_URL -e HA_TOKEN \
    -v /tmp/ha-body.json:/tmp/body.json:ro --entrypoint sh "$IMAGE" -lc \
    'curl -sS -w "\n%{http_code}\n" --max-time 20 -X POST "$HA_URL/api$1" \
       -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" -d @/tmp/body.json' _ "$1"
}
```

The `_ "$1"` at the end is what makes these safe: `sh -lc 'script' _ arg` sets `$0` to `_` and
`$1` to the argument, so the path is passed as **data** rather than spliced into the script
text. The body goes the same way, through a mounted file. Nothing that varies is ever
interpolated into a shell string — which is the only reason these survive an entity id with a
quote in it, or a template body full of braces.

Both print the response followed by the HTTP status on its own last line, so you can read the
outcome and the payload from one call.

Sanity-check the plumbing before relying on it (this runs before the token exists, so `401` is
the expected and correct answer):

```bash
haget /
```

Capture into a variable and default with `${C:-000}` rather than appending `|| echo 000` —
curl already prints `000` itself when a connection fails, so the `||` form runs *both* and
reports `000000`. The `:-` default covers the case where the command produced no output at all,
which means `docker run` failed outright (missing image, missing network) rather than Home
Assistant being unreachable — worth telling apart, so on a bare `000` with no curl error text,
check `IMAGE` and `NET` before blaming the network.

| Result | Meaning |
|---|---|
| `401` | **Success.** Home Assistant is reachable from a container and answering its API. Continue. |
| `200` | Reachable, and something answered `/api/` without auth. Unusual for Home Assistant — confirm with the user that this URL is really their HA instance and not a proxy or placeholder page. |
| `404` | Something answered but it isn't the HA API. Usually a reverse proxy pointed at the wrong backend, or a URL with a leftover UI path. Re-check with the user. |
| `000` | No answer at all — DNS, routing, or TLS. Work the diagnosis below. |

A host-side probe is worth running purely as a diagnostic when the container fails, to tell
"this address is wrong" apart from "this address is host-only":

```bash
curl -sS -o /dev/null -w 'host: %{http_code}\n' --max-time 10 "$HA_URL/api/" 2>/dev/null
```

If the host succeeds where the container fails, the address is host-side only and the user
needs to give you the name Home Assistant has on the container's network — often a short DNS
or Docker name like `homeassistant:8123`, or the LAN IP, rather than the domain they use from
their desktop. Ask for it, set `HA_URL` and `HA_HOST` to the new value, and **re-run the
container probe**. Don't take a replacement URL on faith — that's the whole point of this step.

If both fail, the URL is simply wrong or Home Assistant is down. Don't ask for a second
address; work the diagnosis and re-confirm the original with the user.

### When the container can't reach it

Work through these in order; each is a real cause seen on this stack.

```bash
# a) Does the name resolve inside a container at all?
hac "getent hosts $HA_HOST || echo 'NO DNS'"

# b) Does this host resolve it? If host yes / container no, it's split-horizon or mDNS.
getent hosts "$HA_HOST" || echo 'host cannot resolve it either'
```

- **`.local` / mDNS names** (`homeassistant.local`) usually fail in containers — there's no
  mDNS resolver. Ask for the LAN IP instead, or a real DNS name.
- **Split-horizon DNS** — the host resolves an internal name the container's resolver doesn't.
  Ask for the name that works on the container network.
- **`localhost` / `127.0.0.1`** — resolves to the container itself. Use the LAN IP. If Home
  Assistant runs on this very host and only listens on loopback, `host.docker.internal` reaches
  the host from a container, and HA must be listening on an interface the container can reach.
- **Resolves but times out** — a firewall between the container subnet and HA, or HA listening
  on only one interface.

Do not continue until the container probe returns `401` (or a well-understood `200`). Every
later phase depends on it, and a failure here surfaces much later as an agent that "just
doesn't answer".

### Self-signed certificates

If the probe reports `curl: (60) SSL certificate problem`, Home Assistant is on HTTPS with a
certificate the container doesn't trust. Confirm that's what it is:

```bash
hac "curl -sS -k -o /dev/null -w '%{http_code}\n' --max-time 10 '$HA_URL/api/'"
```

`401` with `-k` and a TLS error without it confirms it. Two honest options — put both to the
user rather than picking for them:

- **Use a certificate the container trusts** (a real CA, or the internal CA already distributed
  to these containers). Cleanest, and nothing else in this skill changes.
- **Mount the issuing CA into the enabled groups** and keep verification on. This is per group,
  and it is extra state REMOVE.md cannot enumerate — write down what you mounted.

Do **not** disable verification in the server. `ha-mcp` has no option for it on purpose: that
would turn off checking for every call the agent makes to Home Assistant, permanently and
invisibly, on the one connection that carries the API token.

## 3. Take the access token

Ask the user to create a long-lived access token:

> In Home Assistant, click your user name (bottom-left) → **Security** tab → scroll to
> **Long-lived access tokens** → **Create token**. Name it `nanoclaw`. Copy it — Home Assistant
> shows it exactly once.

The token inherits that user's permissions, so suggest they create it from an account whose
access they're comfortable giving an agent. Take it into a shell variable without echoing it
back into the conversation:

```bash
read -r -s HA_TOKEN
export HA_TOKEN
```

Prove it works before building anything on it:

```bash
hac 'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/"'
```

`200` is the answer you need. `401` means the token is wrong, expired, or was pasted with
stray whitespace — take it again rather than continuing, because every later failure will look
like something else.

**Keep `HA_TOKEN` in the shell for the rest of this run.** The service phases use it for
discovery and testing, and `token` mode needs it again when writing per-group config. Do not
write it to a file anywhere in the repo, and do not print it.

## 4. Ask the proxy question

This is the user's decision, and it's the one that determines where the token lives. Put it to
them plainly:

> Container traffic normally goes through the OneCLI credential proxy, which holds secrets in a
> vault and injects them into outbound requests. I can either:
>
> **(a) Keep Home Assistant behind the proxy.** The token goes into the OneCLI vault. Agent
> containers never receive it — the proxy adds it in flight. This is the safer option.
>
> **(b) Bypass the proxy for Home Assistant.** The agent's container talks to Home Assistant
> directly, which means the token has to live in a file inside each enabled group's folder, in
> cleartext, readable by anything that can read that group's workspace.
>
> Which would you like?

Record it, and derive nothing else from the scheme — the mode is the user's answer, not a
consequence of HTTP vs HTTPS:

```bash
AUTH_MODE=gateway     # (a) keep it behind the proxy
# AUTH_MODE=token     # (b) bypass the proxy
echo "AUTH_MODE=$AUTH_MODE"
```

Things worth saying while they decide:

- **If OneCLI is missing** (the prerequisite check in `SKILL.md`), option (a) isn't available
  until they run `/init-onecli`. Say so rather than offering a choice that can't be taken.
- **Plain HTTP weakens (a) but doesn't rule it out.** The proxy can still inject on `http://`,
  and `ha-mcp` routes plain HTTP through it deliberately rather than silently going direct. It
  does mean the token crosses the LAN in the clear on the last hop.
- **(b) is the right answer when the proxy can't reach Home Assistant at all** — for example an
  external proxy that has no route to a LAN address. If they've already hit that, they know.

### If `AUTH_MODE=gateway`: store the token in the vault

The gateway matches its host-pattern against the outbound request the container makes, so
`HA_HOST` — the container-side name — is the one that must be in the pattern. Pattern on
anything else and the secret matches nothing, injection silently never happens, and the first
failure is a `401` that takes a while to explain.

Check whether one already exists before creating a duplicate:

```bash
onecli secrets list | grep -i "home assistant"
```

If absent, create it:

```bash
onecli secrets create \
  --name "Home Assistant" \
  --type generic \
  --value "$HA_TOKEN" \
  --host-pattern "$HA_HOST" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Verify it landed:

```bash
onecli secrets list | grep -i "home assistant"
```

Whether the pattern really matches is not something to take on trust. `enable.md` step 4
measures injection from inside a real agent container, and that is the check that settles it.

### If `AUTH_MODE=token`: nothing to do yet

The token goes into each enabled group's `config.env` in `enable.md` step 1. Do not create a
OneCLI secret in this mode — a vault entry that nothing reads is a credential nobody is
tracking.

Say plainly, once, that this is the path where the token lands in cleartext on disk, once per
enabled group, and that choosing (a) instead is what avoids it.

## Carry forward

`HA_URL`, `HA_HOST`, `AUTH_MODE`, `HA_TOKEN`, `IMAGE`, `NET`, and the `hac` helper go into
`${CLAUDE_SKILL_DIR}/install.md` and both service phases.
