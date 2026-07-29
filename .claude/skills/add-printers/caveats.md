# Caveats — read before relying on this for anything sensitive

## 1. The per-group gate is discoverability, not a security boundary — and it leaks further than that

The CUPS ACL is `Allow from <subnet>` — every container on the NanoClaw network is inside
it, whether or not that group ever ran `agent-access.md`. A group without `cups-client`
still has `Bash` and `curl`, and can enumerate `http://host.docker.internal:631/printers/`
directly. It's inconvenient for such a group to hand-encode a full IPP Print-Job from bash,
but not impossible. `cups-client` gates who gets an *easy* path to print — it is not what
stands between an untrusted container and the printer.

It's actually softer than that. `selectedSkillNames()` (`src/container-runner.ts`) resolves
the default `skills: 'all'` selection by re-reading `container/skills/` at every spawn, so
the moment `.claude/skills/add-printers/agent-access.md` copies the `printing` skill into
`container/skills/`, every group on the default `'all'` selection loads it into its runtime
context — printing-enabled or not. **There is no `ncl` verb that writes the `skills`
column** (`ncl groups config update` only accepts scalar fields, and none of the JSON-column
verbs — `add-package`/`remove-package`, `add-mcp-server`/`remove-mcp-server`,
`add-mount`/`remove-mount` — touch `skills`), and reaching that column with raw SQL is an
anti-pattern this skill won't take. So `cups-client` is the only
gate that exists, and it gates capability, not context: a non-enabled group still sees the
printing instructions, will confidently attempt `lp`, and only then discovers `command not
found`. If that context cost is unacceptable, the real fix is a trunk change (an `ncl groups
config set-skills` verb) — out of scope here.

## 2. `packages_apt` pins the group to a frozen base image, forever, silently

`buildAgentGroupImage` builds `FROM <base>:latest` once and writes a slug-scoped derived
image tag (`<CONTAINER_IMAGE_BASE>:<group-id>` — see `src/config.ts`'s
`CONTAINER_IMAGE_BASE`, never the literal `nanoclaw-agent:latest`) that every future spawn
prefers over the shared base. Nothing invalidates that tag automatically. Rebuild the shared
base for any reason — a new channel skill, a CJK fonts toggle, a trunk update — and every
printing-enabled group keeps running its *old* frozen base until someone re-runs `ncl groups
restart --id <group-id> --rebuild`. There is no notification when this drifts; it just
silently stops picking up base-image changes.

## 3. There is no approval gate on print jobs, and there structurally can't be one here

NanoClaw's guard/approval seam (`src/guard/`) covers exactly two entry points: `ncl`
dispatch and delivery actions written into a session's `outbound.db`. Submitting a print job
is a direct container→host TCP connection to cupsd that touches neither, so
`defineGuardedAction`/`requestApproval` cannot see it — this isn't an oversight, it's outside
what that seam observes. The unbypassable limits are the cupsd `MaxRequestSize` / `MaxJobs` /
`MaxJobsPerPrinter` values set in `.claude/skills/add-printers/host-cups.md`, plus the container skill's prose rule to
ask the user before printing anything long. If a hard, unbypassable human approval gate on
printing is ever needed, that requires a real delivery action (agent writes a `print_job`
row to `outbound.db`, the host runs `lp` only on approval) — a much larger change,
deliberately out of scope for this skill.

## 4. Queue defaults are global and host-only — there is no per-group setting

Paper size, color mode, and quality live in one place: the queue's own defaults on the
server (`sudo lpadmin -p <Q> -o …`, step 3 of `.claude/skills/add-printers/printer-setup.md`). Change them and every
client that submits without `-o` inherits the change — every printing-enabled agent group,
the host itself, and anything else on the subnet that prints to that queue. CUPS has no
notion of a per-client default, so "let this one group default to color" is not
expressible; the only way to give one group different defaults is a **second queue** aimed
at the same device.

The container-side route that looks like it should work doesn't. `lpoptions -o` inside a
container writes `~/.cups/lpoptions` on the container's ephemeral layer — it changes that
container's own jobs until it exits, then disappears with it, never reaching another
session of the same group, let alone another group. `lpadmin` *is* present in the container
(`/usr/sbin/lpadmin`, shipped by `cups-client`, just off the `node` user's `PATH`) but the
host answers `lpadmin: Forbidden`, because `host-cups.md` leaves `<Location /admin>`
localhost-only. That's the intended boundary and worth keeping: it's also what stops a
container from cancelling other groups' jobs or disabling the queue. The `printing`
container skill documents both dead ends so an agent reports the limit instead of burning
turns on it.

## 5. Job status is only as good as the queue type

A driverless/IPP-Everywhere queue gets a real back-channel from the printer — out-of-paper
and similar conditions surface in `printer-state-reasons`. A `socket://` (raw 9100) queue
does not: `lp` reporting `completed` only means the bytes were transmitted, nothing about
whether the printer actually produced a page.
