# Caveats — read before relying on this

## 1. Group and capability selection shape what can be asked for — they are not a network boundary

The two gates are real and they are worth having. A group with no `homeassistant` MCP server
registration has no Home Assistant tools in `tools/list`; a capability absent from that group's
`services.json` has no tool either. Neither is hidden-but-present, and neither is a refusal the
agent could be talked out of — there is no tool call that reaches them. That is a genuinely
stronger position than the file-existence check the old `/add-cleaner` used, where every group
loaded the instructions and the config file was the only thing stopping them.

**What it does not do is stop a container from reaching Home Assistant.** An agent has a shell,
and Home Assistant is a plain HTTP API on a reachable host. The tool surface is what shapes
normal behavior; it is not a firewall.

The credential side is where this actually bites, and it surprises people:

- **In `gateway` mode**, every OneCLI agent on this install is `secretMode: "all"` by default. In
  that mode the gateway injects *every* vault secret whose host pattern matches — so once the
  Home Assistant secret exists, its token is injected into **any** agent group's proxied traffic
  to that host, including groups you never enabled. A non-enabled group doesn't know the URL
  from any config of its own, but nothing is stopping it either.
- **In `token` mode**, the token is only in the enabled groups' folders — narrower on this axis,
  and worse on the one in #2.

Making `gateway` a real boundary means putting other agents into `selective` mode
(`onecli agents set-secret-mode --id <agent-id> --mode selective`) and then explicitly assigning
each secret they currently receive for free — which will break their existing credentials if
done carelessly. That is a deliberate, install-wide decision about the whole vault, not a side
effect this skill should cause, which is why it doesn't. Decide it on its own merits.

The honest summary: **selection here is about who gets a working, discoverable capability — not
about who is prevented from reaching Home Assistant.**

## 2. `gateway` mode works by recovering the proxy from `/proc/1/environ`

A stdio MCP server is not spawned with the container's environment. `StdioClientTransport`
merges the server's declared `env` over `getDefaultEnvironment()`, whose allowlist is exactly
`HOME, LOGNAME, PATH, SHELL, TERM, USER`
(`@modelcontextprotocol/sdk/dist/esm/client/stdio.js`). `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`
are dropped.

So a naive MCP server would connect straight to Home Assistant, nothing would inject a token,
and every call would 401 — with no hint a proxy was ever meant to be involved. `proxy.ts` avoids
that by reading PID 1's environment, which in an agent container is the runner itself
(`exec bun run /app/src/index.ts`), and passing the proxy and its CA per-request through Bun's
`fetch`.

Three things follow, all worth knowing:

- **It depends on container internals** — that PID 1 is the runner, that `/proc` is readable, and
  that Bun's `fetch` accepts `proxy` and `tls.ca`. None is exotic and all are checked at startup,
  but it is a layer below the documented MCP contract. The `network:` log line exists so the
  assumption is visible rather than implied; `enable.md` step 4 reads it deliberately, with the
  proxy variables stripped so the test is faithful.
- **A gateway that moves is picked up on the next restart**, because the values are read at
  startup rather than pinned into a config file. That is the reason for the `/proc` read over
  the simpler option of writing `HTTPS_PROXY` into the MCP registration `env`, which would have
  worked on the day it was written and drifted silently afterwards.
- **On plain HTTP the token still crosses the LAN in the clear on the last hop**, gateway mode or
  not. `ha-mcp` routes plain HTTP through the proxy rather than silently bypassing it, so the
  vault still holds the credential — but TLS on the Home Assistant side is what closes this.

### And in `token` mode the token is in cleartext, once per enabled group

`groups/<folder>/home-assistant/config.env`, mode `0600`, on the host disk, inside a directory
mounted read-write into that group's container. That is a real, long-lived Home Assistant token
with the permissions of the user who created it — and Home Assistant long-lived tokens default
to a ten-year lifetime, so it is not self-limiting. It is copied per enabled group, so revocation
means finding every copy (REMOVE.md step 2 does).

## 3. `vacuum.clean_area` is an integration service, not core Home Assistant

`vacuum.start`, `stop`, `pause`, `return_to_base`, and `locate` are core `vacuum` services with a
stable contract. **`vacuum.clean_area` with a `cleaning_area_id` list is not** — it comes from
the vacuum integration, and its argument shape varies: some integrations take string `area_id`s,
others take numeric room or segment ids, and the parameter has been renamed across versions.
Nothing here pins that contract.

The practical effect is that an integration update can break room cleaning while every other
capability keeps working — a failure on `vacuum_clean_area` alone, with `vacuum_control` and
`vacuum_status` fine, is that signature.

This one is at least fixable without touching code. `services.json` accepts overrides:

```json
{ "vacuum": { "clean_area_service": "dreame_vacuum.vacuum_clean_segment", "clean_area_param": "segments" } }
```

Restart the group and it takes effect. The tool tells the agent to report the failure rather
than fall back to a whole-home clean, because "clean my bedroom" turning into "clean the entire
house" is a much worse failure than an error message.

## 4. The room map is keyed on a platform identity string, which is neither permanent nor an authorization check

`rooms.tsv` keys on the message's `sender` attribute verbatim. Two consequences:

**It can change under you.** On WhatsApp the key is normally the phone JID
(`972524525356@s.whatsapp.net`), but a group in LID mode delivers `<id>@lid` instead — a
different string for the same human. Their saved room stops resolving and the agent asks again.
That is the designed failure (ask, re-save) rather than a wrong-room clean, but the old row
lingers. The same applies to a phone number changing hands.

**It is identification, not authorization.** The map answers "which room does this sender call
theirs", and nothing checks whether a sender is *entitled* to run the vacuum. Anyone who can
send a message into an enabled group can start, stop, or redirect it, and can map themselves to
any area in the house — including someone else's bedroom. In a group chat that is everyone in
the chat.

The same reasoning applies to the car, and harder: an enabled group's whole audience can unlock
it and ask where it is, if those capabilities are on. Scope enabled groups accordingly — a
household group is fine, a channel with guests in it is not.

## 5. There is no approval gate on operating a machine, and this design cannot reach one

NanoClaw's guard/approval seam (`src/guard/`) covers exactly two entry points: `ncl` dispatch and
delivery actions written into a session's `outbound.db`. An MCP server making a direct outbound
HTTP call touches neither, so `defineGuardedAction` and `requestApproval` cannot see it. This
isn't an oversight — it's outside what that seam observes.

What actually constrains these machines is two things. The tool surface, which is real: a
capability with no tool cannot be invoked at all, and that is the lever to use — if a whole-home
clean or an unlock is not something you want happening on a message, don't enable it. And prose:
the tool descriptions and the container skill tell the agent to ask before a whole-home clean or
an unlock, to run one job per request, and never to loop or auto-retry. Prose in an agent's
context is a strong default and not a guarantee.

A real gate would mean a delivery action — the agent writes a row to `outbound.db` and the host
makes the call only after an approval — which is a substantially larger change, deliberately out
of scope here.

Blast radius is worth weighing when deciding what to enable. A wrongly-started clean consumes
nothing and is reversible with `stop`; anyone in the room can pick the machine up. A wrongly
unlocked car is not in that category. A printer sits at the mild end — its readings are
read-only and cost nothing, and the only action it usually has is a smart plug, where the damage
is a lost print job and an inkjet cleaning cycle rather than anything that leaves the house
open.
