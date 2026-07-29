# Grant agent groups access

## Install the container skill

```bash
rsync -a .claude/skills/add-printers/container-skills/ container/skills/
```

Copied once regardless of how many groups get access. Every command in that skill already
targets the literal `host.docker.internal` — there's no install-time substitution step, so
this rsync is safe to re-run any time. Verify the copy landed correctly:

```bash
grep -c 'host.docker.internal' container/skills/printing/SKILL.md
```

A nonzero count confirms the file is in place with the real hostname already baked in.

**This makes the skill visible to every agent group, not just the ones you choose below.**
The default `skills: 'all'` resolves by re-reading `container/skills/` at container spawn
(`src/container-runner.ts:427-439`), and there is no `ncl` verb that writes the per-group
`skills` column to scope a skill out — don't hack around that with raw SQL. Document it
instead (see Caveats): every group's agent will see the printing skill's instructions, but
only groups that complete the wiring below actually have `lp` available to run.

## Ask which groups should print

```bash
ncl groups list
```

Ask the user which agent groups should be able to print (`AskUserQuestion` if there are
several candidates).

## Wire each chosen group — both commands, every time

For each `<group-id>` the user picked, run **both** commands:

```bash
ncl groups config add-package --id <group-id> --apt cups-client
ncl groups restart --id <group-id> --rebuild --message "confirm lp is available"
```

`add-package` only writes a row to `container_configs` in the central DB — on its own it
changes nothing running. `restart --rebuild` is what actually calls `buildAgentGroupImage`
and builds a new image tagged `<CONTAINER_IMAGE_BASE>:<group-id>` (`CONTAINER_IMAGE_BASE`
is defined in `src/config.ts:73` — never assume a literal `nanoclaw-agent:latest`), then
respawns the container from it. Skip the second command and the DB says `cups-client` is
installed while the running container still doesn't have it — `lp` fails with
`command not found` and nothing points at why.

The `--message` flag is what makes this take effect immediately: `restart --rebuild`
alone kills the container but does **not** respawn it (`src/container-restart.ts:14-21`) —
it only comes back on the group's next incoming message. Passing `--message` writes an
`on_wake` entry that triggers an immediate respawn, so you can verify right away instead of
waiting for the group to be messaged organically. If the group has no container running at
the time (an idle group), `restartAgentGroupContainers` has nothing to kill or respawn
either way — the rebuild still lands, and the new image is simply used the next time
something wakes the group.

## Verify end-to-end

`<queue>` below is the queue name `Q` from `printer-setup.md`. Tell the user to message one
of the enabled agent groups:

> "Print a test page to `<queue>`."

The agent should have the `printing` container skill loaded and be able to run `lp` against
`host.docker.internal:631`. If it works, paper comes out of the printer. If it doesn't, see
Troubleshooting.
