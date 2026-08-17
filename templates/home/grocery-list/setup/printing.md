# Printing — the walkthrough

Paper is optional. Everything else in this template works without it: `grocery.ts printable`
renders the PDF with headless Chromium inside the container and needs nothing from the host.
This step exists only for `grocery.ts print`, which puts the sheet on a real printer.

Three parts, in order, and the order matters — each one is what makes the next verifiable:

1. **Host CUPS** — install it and make it reachable from the container network.
   → `host-cups.md`
2. **The printer** — identify it over IPP, create a driverless queue, set the queue's
   defaults, print a test page. → `printer-setup.md`
3. **The group** — put `cups-client` in this group's image so `lp` exists, then verify from
   inside the container. → below.

Read `caveats.md` before promising anything. Five structural limits live there, and two of
them change what you should tell the operator: there is **no approval gate** on a print job
that this design can reach, and queue defaults are **global**, shared by every agent group on
this host.

These procedures are adapted from the `/add-printers` skill that lives in this NanoClaw
install. The template keeps its own copy on purpose, so a stamped group depends on nothing
outside itself. If both exist, they do the same thing and either is fine — but do not run
them interleaved.

## Before you start

```bash
grep -E '^NANOCLAW_EGRESS_LOCKDOWN=true' .env
grep -E 'NANOCLAW_EGRESS_LOCKDOWN=true' \
  "$HOME/.config/systemd/user/"*.service "$HOME/.config/systemd/user/"*.service.d/*.conf 2>/dev/null
```

If either matches, the agent network runs `--internal` and containers cannot reach the host
gateway at all — **no container-to-cupsd path can work**. Stop and tell the operator: they
must set `NANOCLAW_EGRESS_LOCKDOWN=false`, accepting the wider egress surface, wherever it is
set, before any of this can do anything.

Also check whether CUPS is already configured here — another group, or the `/add-printers`
skill, may have done parts 1 and 2 already:

```bash
systemctl is-active cups 2>/dev/null || echo "not-active"
lpstat -p -d 2>/dev/null
```

An active cupsd with a queue means you can skip to part 3 and verify.

## Part 3 — give this group `lp`

Two commands, both of them, every time:

```bash
ncl groups config add-package --id <group-id> --apt cups-client
ncl groups restart --id <group-id> --rebuild --message "confirm lp is available"
```

`add-package` only writes a row in the central DB — on its own it changes nothing running.
`restart --rebuild` is what actually builds a new image for this group and respawns the
container. Skip the second and the DB says `cups-client` is installed while the running
container still does not have it: `lp` fails with `command not found` and nothing points at
why.

`--message` is what makes it take effect now rather than at the group's next incoming
message: `restart --rebuild` alone kills the container without respawning it. If the group is
idle and has no container running, the rebuild still lands and the new image is used the next
time something wakes it.

## Verify, from inside the container

The only verification that counts, because everything above is host-side and the failure this
catches is not:

```bash
ncl groups restart --id <group-id> \
  --message "run: lpstat -h host.docker.internal:631 -p -d"
```

Read the run log. A queue listing means the whole path works. Anything else — `command not
found`, `Scheduler is not running`, or the misleading `add '/version=1.1'` — is diagnosed in
the template's own `skills/printing/references/errors.md`, which is the same table the agent
will read when it hits the problem in a real conversation.

Then prove the verb itself, with something on the list:

```bash
ncl groups restart --id <group-id> \
  --message "run: bun /workspace/agent/plugins/grocery-list/tools/grocery.ts print"
```

Without `--yes` it must **refuse**, naming the queue and the page count. That refusal is the
feature: it is the confirmation the group answers before any paper moves.

## If printing is declined

Nothing to do. `grocery.ts print` exits non-zero either way, with the line that matches the
state: without `cups-client` in the image it reports that `lp` is not installed (exit 4);
with the client installed but no queue behind it, that no printer is configured (exit 3).
Both are plain sentences the agent can pass on, and the PDF path is unaffected, and a group that later changes its mind has a route from inside
the container — `install_packages({apt:["cups-client"]})`, which raises an admin approval and
rebuilds on approve. That still cannot fix the host half; it brings whoever asked straight
back to this file.
