# Remove Home Assistant control

Idempotent — safe to run even if some steps were never applied.

This skill leaves state **outside the repo**: per-group rows in the central DB, a secret in the
OneCLI vault, a long-lived token inside Home Assistant itself, and config files per enabled
group. None of that is reversed by a `git revert`, so most of what follows is operator action
against live state rather than a code change.

To remove **one service** or **one group** rather than everything, stop after step 2 — that is
where the per-group scoping lives.

## 1. Find the enabled groups

Two sources, because a group can be half-enabled and each half fails differently:

```bash
ls -d groups/*/home-assistant 2>/dev/null || echo "no group config files"
ncl groups list --json | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | while read -r G; do
  ncl groups config get --id "$G" 2>/dev/null | grep -q homeassistant && echo "registered: $G"
done
```

Work through the union of both lists in the steps below.

## 2. Remove the per-group state

### The credential

**In `token` mode `config.env` contains the Home Assistant token, so this is a credential
removal, not a cleanup.** Do it before anything else.

```bash
rm -f "groups/<folder>/home-assistant/config.env"
```

### One service, or all of them

To drop a single service and keep the others, edit `services.json` rather than deleting it. The
key is `vacuum`, `car`, or `printers`:

```bash
node -e '
  const fs = require("fs");
  const [target, drop] = process.argv.slice(1);
  const cur = JSON.parse(fs.readFileSync(target, "utf8"));
  delete cur[drop];
  fs.writeFileSync(target, JSON.stringify(cur, null, 2) + "\n");
' "groups/<folder>/home-assistant/services.json" vacuum
```

To drop **one printer** out of several, edit the `printers` array instead — same file, same
restart, and the other printers keep working.

Then skip to step 3 — the group keeps working, with fewer tools.

To remove everything for this group:

```bash
ncl groups config remove-mcp-server --id "<group-id>" --name homeassistant
rm -f "groups/<folder>/home-assistant/services.json"
```

Unregistering is what makes the tools disappear; the files are what make the server say "not
enabled". Doing only one of the two leaves a group that half-works.

### The room map

`rooms.tsv` is different. It's the room mapping the group's users built up by answering
questions, and it is the one thing here that can't be regenerated. **Ask before deleting it.**
If they might re-enable the vacuum later, keep it — the server picks it back up untouched.

```bash
# only with explicit confirmation:
rm -rf "groups/<folder>/home-assistant"
```

Repeat for every group from step 1.

## 3. Restart the affected groups

```bash
ncl groups restart --id "<group-id>"
```

No `--rebuild` — this skill installed no packages, so the image is unchanged. MCP servers are
launched at spawn, so a live container keeps its tools until it's replaced; the group comes back
without them on its next incoming message.

To verify immediately instead, add `--message "confirm your Home Assistant tools are gone"` and
the agent should say Home Assistant isn't connected for it.

## 4. Delete the OneCLI secret

Only if `AUTH_MODE` was `gateway` — in `token` mode no secret was created.

```bash
onecli secrets list | grep -i "home assistant"
onecli secrets delete --id <secret-id>
onecli secrets list | grep -i "home assistant"   # confirm it's gone
```

Deleting the secret stops the gateway injecting it, which is what breaks any leftover
`gateway`-mode access — including from groups that were never explicitly enabled (caveats.md #1).

## 5. Revoke the token in Home Assistant

**Do not skip this, and don't treat step 4 as a substitute.** Deleting the vault entry removes
NanoClaw's copy; the token itself stays valid in Home Assistant until it's revoked there. In
`token` mode it was also sitting in cleartext on disk, so treat it as exposed regardless of who
you think read it.

Tell the user:

> In Home Assistant, click your user name (bottom-left) → **Security** tab → **Long-lived access
> tokens** → delete the `nanoclaw` token.

## 6. Remove the code

Only once no group is still registered — step 2 for every group first, or those groups get an
MCP server that fails to start.

```bash
rm -rf container/agent-runner/src/ha-mcp
rm -rf container/skills/homeassistant
```

Safe whether or not either directory exists. Then confirm the tree is still clean without them:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

## 7. If a CA certificate was mounted

`connect.md` offers mounting an internal CA as one way to handle a self-signed Home Assistant
certificate. That is per-group extra state this file can't enumerate, because what was mounted
depends on what the operator chose:

```bash
ncl groups config get --id "<group-id>"    # inspect additional_mounts
```

Remove any mount added for this **only if nothing else uses that CA** — a shared internal CA is
frequently also serving other self-hosted services, and pulling it breaks those instead. The
verb needs both sides of the mount, not a single path:

```bash
ncl groups config remove-mount --id "<group-id>" --host <host-path> --container <container-path>
ncl groups restart --id "<group-id>"      # remove-mount only edits the DB row
```
