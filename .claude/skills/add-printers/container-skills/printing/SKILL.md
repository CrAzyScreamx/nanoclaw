---
name: printing
description: Print documents to a physical printer via the host's CUPS server. Use when asked to print, send to printer, get a hard copy, put something on paper, or otherwise produce a physical printout.
---

# Printing

You can send documents to a physical printer through CUPS running on the host, reachable
at the literal hostname `host.docker.internal`. Every command below must include that host
explicitly — CUPS does not listen on this container's own localhost.

## Checking what's available

Before printing, list the queues and see which one is default:

```bash
lpstat -h host.docker.internal:631 -p -d
```

## Submitting a job

```bash
lp -h host.docker.internal:631 -d <queue> -o sides=two-sided-long-edge -n 2 file.pdf
```

- `-d <queue>` — target queue (from `lpstat -p` above)
- `-o sides=two-sided-long-edge` — duplex; drop it for single-sided, or use
  `sides=two-sided-short-edge` for short-edge binding
- `-n 2` — number of copies
- Always print the actual file you were asked to print. Don't improvise a substitute
  file just to get something to submit.

## Changing print settings

Two different things, and only one of them is yours to change.

**For a single job — yours.** Pass `-o` flags on the `lp` command. This covers almost every
real request ("print it in color", "use Letter", "high quality") and needs no permission
from anyone:

```bash
lp -h host.docker.internal:631 -d <queue> -o ColorModel=RGB -o cupsPrintQuality=High file.pdf
```

Check what the queue actually offers before promising anything — `*` marks the current
default:

```bash
lpoptions -h host.docker.internal:631 -p <queue> -l
```

An option the queue doesn't list is **silently ignored, not refused**. Sending
`-o sides=two-sided-long-edge` to a single-sided printer prints one-sided and reports
success, so check the list rather than assuming the printer can do what was asked.

**The queue's own defaults — not yours.** When asked to make something the default from now
on ("always print in gray", "default to A4"), do not try to do it. Two dead ends, both of
which look like they might work:

- `lpoptions -o …` writes into *this container's* `~/.cups/lpoptions`. That file is on the
  container's ephemeral layer, so it changes your own submissions until this container
  exits and then silently disappears — worse than doing nothing, because it looks like it
  took effect. It never reaches other sessions, other agent groups, or the host.
- `lpadmin -o …` is the command that would really work, and the host refuses it:
  `lpadmin: Forbidden`. CUPS admin operations are restricted to the host itself.

Tell the person who asked, plainly: queue defaults are set on the host, not from here.
Give them the command to run there:

```bash
sudo lpadmin -p <queue> -o ColorModel=Gray -o PageSize=A4 -o cupsPrintQuality=Normal
```

Say what it affects: there is one queue and one set of defaults, so this changes printing
for **every** agent group and every machine that prints to it, not just this group. If they
only want it for the job in front of them, use the per-job `-o` flags above instead — that's
usually what "make it color" actually means, and it needs nobody's involvement.

## Rendering a page to PDF first

If you're printing a rendered page (e.g. via `agent-browser` / headless Chromium) rather
than an existing file, pass both `--no-sandbox` and `--no-pdf-header-footer`:

```bash
chromium --headless --no-sandbox --print-to-pdf=file.pdf --no-pdf-header-footer <url>
```

Without `--no-sandbox`, this container's Chromium silently writes no PDF at all — check
the file actually exists before trying to print it. Separately, this Chromium build
**ignores** `--print-to-pdf-no-header` — that flag name still stamps a date/title/`file://`
header and footer onto every page. Use `--no-pdf-header-footer` (no `-no-header` suffix) or
the printout will have that cruft baked in.

## Checking job status

```bash
lpstat -h host.docker.internal:631 -W completed -o <queue>
```

**Be honest with the user about what this does and doesn't tell you.** `lp` exiting 0
only means cupsd *accepted* the job — not that it printed, and not that it's on paper.
What you can learn afterward depends on the queue type:

- A **driverless/IPP queue** has a real back-channel: `lpstat -l -p <queue>` surfaces
  `printer-state-reasons` like `media-empty-error`, `toner-low`, or `offline-report` if
  something is actually wrong.
- A **`socket://` queue** (raw port 9100, no driver) has no back-channel at all. CUPS
  marks the job `completed` the instant the bytes are transmitted, whether or not the
  printer is even powered on. Out-of-paper, out-of-toner, and offline states never
  surface for this kind of queue.

If the user asks "did it print?" and the queue is `socket://`-backed, say plainly that
CUPS can't confirm physical output — only the person standing near the printer can.

## Rules

- **State the page count and ask the user before submitting anything over ~10 pages.**
  Don't guess at what "a lot" means — count the pages in the source document (or PDF)
  first, then ask if it's more than ~10.
- **Never print in a loop.** One job per request. If a job needs to be resubmitted, ask
  the user first — don't retry automatically.
- **Never re-submit a job just because status polling was slow or timed out.** A slow
  `lpstat` response is not evidence the job failed. Re-submitting a job that's actually
  still queued or printing produces duplicate paper. If status is unclear after a
  reasonable wait, tell the user rather than resubmitting.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `lp: command not found` | Either this agent group was never granted printing, or it was granted `cups-client` but the container is still running a stale image from before that rebuild | Tell the user rather than trying to fix it yourself — an operator needs to confirm this group has printing enabled and, if it should, run `ncl groups config add-package --id <group-id> --apt cups-client` and `ncl groups restart --id <group-id> --rebuild --message "confirm lp is available"` |
| `lpstat: Scheduler is not running.` / `lp: Error - The printer or class does not exist.` | cupsd on the host isn't reachable at `host.docker.internal:631`, or this container's subnet isn't in cupsd's ACL. **The second message names the queue but is misleading** — it's the generic error `lp` gives whenever it can't reach cupsd at all, not a sign the queue name is wrong | Host-side CUPS outage or ACL issue — report it to the user rather than hunting for a different queue name |
| `lpadmin: Forbidden` (or the same from `cancel -a`, `cupsdisable`, `lpmove`) | Expected, not a misconfiguration — CUPS admin operations are restricted to the host. You cannot change queue defaults, cancel other people's jobs, or disable a queue from here | Tell the user it has to be done on the host and give them the command — see **Changing print settings** above. Don't retry, and don't look for another way in |
| `client-error-not-authorized` | CUPS access control (ACL) is rejecting this request | Host-side CUPS policy issue — report it to the user rather than retrying |
| Job accepted but stuck in queue (never shows `completed`) | Printer offline, out of paper/toner (if the queue surfaces state), or a stalled backend | Check `lpstat -h host.docker.internal:631 -l -p <queue>` for `printer-state-reasons`; if it's a `socket://` queue there may be nothing to see — report the stuck job to the user |
