# Caveats — read before promising anything about printing

Five structural limits. None of them is a bug to be fixed in this template, and two of them
change what you should tell the operator before they agree to set printing up at all.

## 1. The per-group gate is discoverability, not a security boundary

The CUPS ACL is `Allow from <subnet>` — **every** container on the NanoClaw network is inside
it, whether or not that group was ever given `cups-client`. A group without it still has Bash
and `curl`, and can enumerate `http://host.docker.internal:631/printers/` directly. Hand-
encoding a full IPP Print-Job from bash is inconvenient, not impossible. `cups-client` gates
who gets an *easy* path to print; it is not what stands between an untrusted container and
the printer.

It is softer still on the context side. The default skill selection re-reads the install's
`container/skills/` at every container spawn, so a `printing` container skill installed for
one group loads into every group on that default — printing-enabled or not. This template
ships **its own** `skills/printing/`, which lands in this group's overlay only, so the
template does not widen that. But if the install also has the container skill, the wider
exposure is already there and is not something this template can narrow.

## 2. `packages_apt` pins the group to a frozen base image, silently

Adding `cups-client` builds a derived image for this group once, from the base as it was at
that moment, and every later spawn prefers that tag. Nothing invalidates it automatically.
Rebuild the shared base for any reason — a new channel skill, a fonts toggle, a NanoClaw
update — and this group keeps running its *old* frozen base until someone re-runs
`ncl groups restart --id <group-id> --rebuild`. There is no notification when it drifts; the
group simply stops picking up base-image changes.

This is worth saying out loud before printing is enabled: it is a standing maintenance cost
attached to one optional feature.

## 3. There is no approval gate on a print job, and this design cannot reach one

NanoClaw's guard/approval seam covers `ncl` dispatch and delivery actions written into a
session's outbound queue. Submitting a print job is a direct container→host TCP connection to
cupsd, which touches neither, so an approval cannot see it. That is not an oversight — it is
outside what that seam observes.

What actually bounds it, in order of strength:

1. The cupsd ceilings from `host-cups.md` — `MaxRequestSize`, `MaxJobs`, `MaxJobsPerPrinter`.
   Unbypassable, enforced by cupsd itself.
2. `grocery.ts print` refusing without `--yes`, so a paper job needs an explicit answer in
   chat for that specific job.
3. The prose rules in the `printing` skill: one job per request, never in a loop, never a
   resubmit on slow status.

Only the first of those is enforcement. If a hard, unbypassable human gate on printing is
ever needed, that is a real delivery action in NanoClaw itself — the agent writing a row and
the host running `lp` on approval — and it is deliberately out of scope here.

## 4. Queue defaults are global and host-only

Paper size, colour mode and quality live in one place: the queue's own defaults on the server
(`sudo lpadmin -p <Q> -o …`, step 3 of `printer-setup.md`). Change them and every client that
submits without `-o` inherits it — every printing-enabled agent group, the host itself, and
anything else on the subnet that prints to that queue. CUPS has no notion of a per-client
default, so "let this one group default to colour" is not expressible; the only way to give
one group different defaults is a **second queue** aimed at the same device.

The container-side route that looks like it should work does not. `lpoptions -o` inside a
container writes `~/.cups/lpoptions` on the container's ephemeral layer: it changes that
container's own jobs until it exits, then disappears with it. `lpadmin` *is* present in the
container (shipped by `cups-client`, just off the default `PATH`) but the host answers
`lpadmin: Forbidden`, because `host-cups.md` leaves `<Location /admin>` localhost-only. That
is the intended boundary and worth keeping — it is also what stops a container cancelling
another group's jobs or disabling the queue. The template's `printing` skill documents both
dead ends so the agent reports the limit instead of burning turns on it.

## 5. Job status is only as good as the queue type

A driverless/IPP-Everywhere queue gets a real back-channel from the printer — out-of-paper and
similar conditions surface in `printer-state-reasons`. A `socket://` (raw 9100) queue does
not: `lp` reporting `completed` only means the bytes were transmitted, nothing about whether
the printer produced a page.

`grocery.ts print --yes` reports the job id it was given, and that is exactly as strong as the
queue behind it. On a `socket://` queue, "sent to the printer" is the honest claim and "it
printed" is not.
