---
name: add-printers
description: Add network printing so NanoClaw agents can put a document on paper. Installs and configures host CUPS, identifies a network printer over IPP, creates a driverless print queue, and grants chosen agent groups the `lp` command via a container skill. Triggers on "add printer", "printing", "print", "hard copy", "CUPS", "IPP", "print a document", "add-printers".
---

# Add Printers

Gives chosen agent groups the ability to print a document to a real network printer. Most
installs have **no CUPS at all**, so this skill installs and configures CUPS on the host,
then teaches selected agent groups to submit jobs to it over IPP.

**Principle:** do the work — don't tell the user to do it. Only ask for input that is
genuinely manual: the printer's IP, a model name if auto-identification fails, the queue
defaults the user wants (paper size, color mode, quality), confirmation *before* any job is
sent to the printer, confirming the test page physically came out, and which agent groups
get access.

Printing is one of the few things an agent does that consumes something physical. Never
send a job — test page included, and every retry after it — without asking first.

Every phase is idempotent — safe to re-run from the top if interrupted, or to re-apply later
(e.g. to add another group or another printer).

## Prerequisites

```bash
test -d container/skills/printing && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If `ALREADY APPLIED`, host CUPS and the container skill are already in place — skip straight
to phase 3 to wire up another agent group, or phase 2 to add another printer.

```bash
grep -E '^NANOCLAW_EGRESS_LOCKDOWN=true' .env
grep -E 'NANOCLAW_EGRESS_LOCKDOWN=true' \
  "$HOME/.config/systemd/user/"*.service "$HOME/.config/systemd/user/"*.service.d/*.conf 2>/dev/null
```

If either matches, the agent network runs `--internal` and containers cannot reach the host
gateway at all — no container-to-cupsd path can work. **Stop and tell the user**: they must
set `NANOCLAW_EGRESS_LOCKDOWN=false` (accepting the wider egress surface) in whichever place
it's set before this skill can do anything.

## Phases

Run these in order.

1. **Host CUPS** — install and configure CUPS on the host: resolve the container network's
   gateway IP and subnet, install the packages, and edit `cupsd.conf` to listen on the
   gateway with a subnet-scoped ACL. **Read `${CLAUDE_SKILL_DIR}/host-cups.md` and follow it
   before continuing.** `GATEWAY_IP` and `SUBNET` are resolved and consumed entirely within
   this phase — later phases don't need them. Note the values anyway: Troubleshooting below
   refers to them, and `REMOVE.md` needs to recognize the lines they produced.
2. **Printer setup** — identify the printer over IPP, create a driverless queue, set the
   queue defaults the user wants, then — after asking — print a test page and get the user
   to confirm paper came out.
   **Read `${CLAUDE_SKILL_DIR}/printer-setup.md`.** Needs host CUPS running from phase 1.
   Ends with a queue name, `Q`.
3. **Agent access** — install the `printing` container skill and grant chosen agent groups
   `cups-client`.
   **Read `${CLAUDE_SKILL_DIR}/agent-access.md`.** Needs the queue name from phase 2.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Agent says `lp: command not found` | That agent group never got `cups-client`, or got the package added but not rebuilt. Re-run the wiring steps in `${CLAUDE_SKILL_DIR}/agent-access.md` for that group. |
| A group offers to print, then reports `lp: command not found` | The `printing` container skill loads into every group on the default `skills: 'all'` selection, whether or not that group has `cups-client` — see `${CLAUDE_SKILL_DIR}/caveats.md` #1. Either grant that group `cups-client` via `${CLAUDE_SKILL_DIR}/agent-access.md`, or tell it printing isn't available to it. |
| Agent's `lp` hangs or "connection refused" | cupsd isn't listening on `GATEWAY_IP:631`. See the `ss -lntp` check in `${CLAUDE_SKILL_DIR}/host-cups.md`. |
| Agent's `lp`/`lpstat` reports `Error - add '/version=1.1' to server name` | Not a version mismatch — cupsd rejected the `Host: host.docker.internal` header with 400 because the `ServerAlias` line is missing. Add it per `${CLAUDE_SKILL_DIR}/host-cups.md`. Confirm first by re-running the same command against the gateway IP instead of the name: if that works, this is it. |
| Agent's `lp` reports `client-error-not-authorized` | The container's source IP isn't covered by the `Allow from <subnet>` ACL. Re-check the subnet in `${CLAUDE_SKILL_DIR}/host-cups.md` — it can drift if the docker network was recreated. |
| Agent jobs ignore the defaults you set (still color, wrong paper) | The defaults were written with `lpoptions -o`, which is local-client only, instead of `lpadmin -p <Q> -o`, which writes them on the server where remote container jobs pick them up. Re-apply per step 3 of `${CLAUDE_SKILL_DIR}/printer-setup.md`. |
| Test page said `completed` but nothing printed | Queue is `socket://` (raw 9100), which has no back-channel — see `${CLAUDE_SKILL_DIR}/printer-setup.md`. Check the printer's own panel. |
| Job sits in the queue indefinitely | Printer is offline, out of paper, or unreachable — check its physical state directly. |
| A non-enabled group can query the printer list | Expected — the ACL is a subnet boundary, not a per-group one. See `${CLAUDE_SKILL_DIR}/caveats.md` #1. |
| Printing worked, then stopped after an unrelated base-image update | The enabled group's derived image is pinned to an old base snapshot. See `${CLAUDE_SKILL_DIR}/caveats.md` #2 for the rebuild fix. |

## Caveats

Five structural limits, summarized here — read `${CLAUDE_SKILL_DIR}/caveats.md` in full
before relying on this for anything sensitive:

1. The `cups-client` gate is discoverability, not a security boundary — and the container
   skill itself is visible to every group regardless.
2. `packages_apt` pins a group to a frozen base image; nothing invalidates it automatically.
3. There is no approval gate on print jobs, and this skill's design cannot reach one.
4. Queue defaults are global and host-only — one queue, one set of defaults, shared by every
   group; a container cannot change them, and per-group defaults need a second queue.
5. Job status is only as good as the queue type — a `socket://` queue never reports failures.

## Testing

This skill's only functional integration point is a runtime `ncl` action
(`add-package`/`restart --rebuild`) with no in-tree source footprint — there is no line in
the repository whose deletion a test could catch, since the effect lives in the central DB
and a derived Docker image, both outside the tree. The only in-tree artifact is a copied
container skill, which no test can meaningfully guard — copying it is the whole effect, and
verifying the copy is just re-stating the `rsync` command. Per `docs/skill-guidelines.md`
("When there is genuinely nothing to test in-tree"), this is a conformant outcome for this
shape of reach-in, stated here explicitly rather than adding a hollow test.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure. Unlike most skills, this
one leaves real state **outside the repo** — a running `cups` service, a `cupsd.conf` edit,
and a print queue — so REMOVE.md reverses host state, not just files.
