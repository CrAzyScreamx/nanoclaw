# Remove ElevenLabs calling

Idempotent — safe to run even if some steps were never applied.

This skill leaves state **outside the repo**: per-group rows in the central DB, per-group config
files, possibly a live polling task series, a secret in the OneCLI vault, and a working API key
in the ElevenLabs dashboard. None of that is reversed by a `git revert`, so most of what follows
is operator action against live state rather than a code change.

To remove **one group** rather than everything, stop after step 4 — that is where the per-group
scoping lives.

## 1. Find the enabled groups

Two sources, because a group can be half-enabled and each half fails differently:

```bash
ls -d groups/*/elevenlabs 2>/dev/null || echo "no group config files"
ncl groups list --json | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | while read -r G; do
  ncl groups config get --id "$G" 2>/dev/null | grep -q elevenlabs && echo "registered: $G"
done
```

Work through the union of both lists in the steps below.

## 2. Cancel any live call-polling tasks

Do this **first**. A `el-call-…` series left behind keeps firing every two minutes against a
server whose files are about to be deleted, and each fire spawns the group's container.

```bash
ncl tasks list --all
```

Cancel every series whose id starts with `el-call-`:

```bash
ncl tasks cancel --id <series-id>
```

If one of them belongs to a call that is genuinely still in progress, say so before cancelling —
the transcript stays in ElevenLabs and can be read from the dashboard, but nobody will be woken
to summarize it.

## 3. Unregister the server per group

```bash
ncl groups config remove-mcp-server --id "<group-id>" --name elevenlabs
ncl groups config get --id "<group-id>" | grep -c elevenlabs
```

Unregistering is what makes the tools disappear. Do it for every group from step 1.

## 4. Delete the per-group config

```bash
rm -rf "groups/<folder>/elevenlabs"
```

This file holds no credential — only agent ids, phone numbers and variable names — but leaving
it behind means a re-registered server silently comes back with the old persona list. Repeat for
every group from step 1.

Steps 3 and 4 go together: doing only one of the two leaves a group that half-works.

## 5. Restart the affected groups

```bash
ncl groups restart --id "<group-id>"
```

No `--rebuild` — this skill installed no packages, so the image is unchanged. MCP servers are
launched at spawn, so a live container keeps its tools until it is replaced; the group comes back
without them on its next incoming message.

To verify immediately instead, add `--message "confirm your ElevenLabs call tools are gone"` and
the agent should say it can't place calls.

## 6. Delete the OneCLI secret

```bash
onecli secrets list | grep -i elevenlabs
onecli secrets delete --id <secret-id>
onecli secrets list | grep -i elevenlabs   # confirm it's gone
```

Deleting the secret stops the gateway injecting the key, which is what closes off any leftover
access from groups that were never explicitly enabled (`caveats.md` #2).

## 7. Revoke the key in ElevenLabs

**Do not skip this, and don't treat step 6 as a substitute.** Deleting the vault entry removes
NanoClaw's copy; the key itself keeps working in ElevenLabs — and keeps being billable — until
it is revoked there.

Tell the user:

> In the ElevenLabs dashboard, open your profile menu → **API Keys** → find the `nanoclaw` key →
> **Delete**.

Have them confirm it is gone from the list before you call this done.

## 8. Remove the code

Only once no group is still registered — step 3 for every group first, or those groups get an
MCP server that fails to start.

```bash
rm -rf container/agent-runner/src/elevenlabs-mcp
rm -rf container/skills/elevenlabs-calls
```

Safe whether or not the directories exist. `container/skills/homeassistant` and
`container/agent-runner/src/ha-mcp` are a different skill's files — leave them alone
(`caveats.md` #6).

Then confirm the tree is still clean without them:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```
