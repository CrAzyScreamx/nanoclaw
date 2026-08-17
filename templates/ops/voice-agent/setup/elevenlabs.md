# Setup 3 — the ElevenLabs key

Required. Without it every tool in the template returns a translated 401 and the
agent has nothing to operate.

Read `SETUP.md`'s rule first: the raw key never passes through this session. You
walk the operator to the dashboard, hand them one command to run in their own
terminal, and then verify without ever seeing the value.

## 1. Create the key, with the right permissions

Operator, in the ElevenLabs dashboard → **API keys** → create a key. The
permission ticks matter more than the key does:

| Permission | Level | Why |
|---|---|---|
| **ElevenAgents** | Write | personas, phone numbers, dialing, batch calling, transcripts |

That is the whole list. Every path the tools call lives under `/v1/convai/`,
which the key form exposes as this one tri-state scope — No Access / Read /
Write, where Write includes Read. Phone numbers are part of it rather than a
separate permission, so do not go hunting for a second tick.

**Read** is enough for `lines.ts list`, `personas.ts list/show` and `calls.ts`
and nothing else — a Read key looks connected right up until the first
`personas.ts create` or `call.ts dial`, which is the worst moment to find out.
Set it to Write now.

While the form is open, set its **Usage Limits (Credits)** cap too. It is the
one spend ceiling ElevenLabs enforces itself, and this is the only moment it
costs nothing to add — see `guardrails.md` §1 for how to pick the number.

The **monitor** route (ending a call in flight over the ElevenLabs control
WebSocket) additionally needs an **enterprise plan**, an **ElevenAgents: Write**
key, and for the operator's own account to hold the **EDITOR** workspace role —
that last one is a member role granted in workspace settings, not a tick on this
form. Everything else in the template works without it, and the carrier route in
`hangup-twilio.md` is the one to reach for instead.

## 2. Put it in the vault

Hand the operator this, to run **in their own terminal** — not with `!`, not in
this session. The `export` on its own line is what keeps the key off the command
line of the command that uses it:

```bash
export XI_API_KEY='<paste the key here>'

onecli secrets create \
  --name "ElevenLabs" \
  --type generic \
  --value "$XI_API_KEY" \
  --host-pattern "api.elevenlabs.io" \
  --header-name "xi-api-key" \
  --value-format "{value}"
```

Then wait for them to say it is done, and move to step 3.

**`--value-format "{value}"`, not `Bearer {value}`.** ElevenLabs wants the bare
key on a non-standard `xi-api-key` header. The `Bearer` default sends a header
ElevenLabs rejects, and the failure looks like a bad key rather than a bad
format — hours get spent regenerating a key that was fine.

**The on-demand connect-link flow does not cover this.** That flow only knows
standard `Authorization` connectors, and `xi-api-key` is not one. Either the
command above runs on the host, or the same three fields — host pattern, header
name, value format — go in by hand in the OneCLI UI, at whatever address
`ONECLI_URL` in the host's `.env` gives (often `127.0.0.1:10254`, but on a
Docker-bridge install the bridge address such as `172.17.0.1:10254`, and there
the loopback form does not answer). There is no third route, and the agent
cannot do it from inside the container.

Re-running the command with a rotated key is fine; that is what makes this step
idempotent.

## 3. Verify — twice, in the right order

**The entry exists** (names and host patterns only, no values):

```bash
onecli secrets list
```

**The entry works.** `onecli run` executes a command with gateway access, so
this exercises the real injection path — host pattern, header name, value
format — without a container and without the key ever being visible:

```bash
onecli agents list                                  # find this group's agent id
onecli run --agent <agent-id> -- curl -s -o /dev/null -w '%{http_code}\n' \
  https://api.elevenlabs.io/v1/convai/agents
```

`200` means connected. `401` means one of exactly four things, in the order
they are worth checking:

1. the value format was left as `Bearer {value}`;
2. the host pattern has a typo;
3. the agent is in `selective` secret mode (step 4);
4. the key itself is wrong or revoked.

Omitting `--agent` uses OneCLI's default agent, which is not necessarily this
group's — a `200` from the default agent and a `401` from the group's is exactly
what cause 3 looks like, so pass `--agent` deliberately.

## 4. Secret mode

Agents default to `all`, so every vault secret whose host pattern matches is
injected and there is usually nothing to do. If the check above says otherwise:

```bash
onecli agents set-secret-mode --id <agent-id> --mode all
```

No container restart is needed; the gateway looks up secrets per request.

## 5. Say who else can reach this key

**The vault entry is install-wide.** On `all`, the gateway injects the
ElevenLabs key into **any** group's traffic to `api.elevenlabs.io`, not just
this one. Other groups get no tools, no persona list and no phone number — but
they do have a shell, and a shell plus an injected key is enough to reach the
API and spend money on it.

That is an install-wide decision, so make it out loud rather than by default. If
this host runs groups that should not be able to reach the operator's ElevenLabs
account:

```bash
onecli secrets list --fields id,name,hostPattern            # the ElevenLabs secret's id
onecli agents set-secret-mode --id <agent-id> --mode selective
onecli agents set-secrets --id <agent-id> --secret-ids <secret-id>[,<secret-id>…]
```

`set-secrets` **replaces** the assignment list rather than adding to it, so pass
every secret that agent still needs — check `onecli agents secrets --id
<agent-id>` first if it already had some.

`selective` then re-verifies with the `onecli run --agent` check in step 3 —
narrowing injection is the single most common way to turn a working setup into a
401 an hour later.

## Teardown

Deleting the vault entry (`onecli secrets delete …`) only removes NanoClaw's
copy. The key keeps working — and keeps being **billable** — until it is revoked
in the ElevenLabs dashboard. Say both halves whenever a user asks to disconnect;
one of them is the one that stops the money.
