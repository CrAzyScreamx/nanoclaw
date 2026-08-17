---
name: printing
description: Print documents to a physical printer via the host's CUPS server. Use when asked to print, send to printer, get a hard copy, put something on paper, or otherwise produce a physical printout.
---

# Printing

You can send documents to a physical printer through CUPS running on the host, reachable
at the literal hostname `host.docker.internal`. Every command below must include that host
explicitly — CUPS does not listen on this container's own localhost.

**The shopping list has its own verb, and it is the one to use.**
`bun /workspace/agent/plugins/grocery-list/tools/grocery.ts print` re-renders the current
list, resolves the queue, and submits exactly one job — it refuses without `--yes` and tells
you the queue and the page count first. Never hand-roll `lp` for the list: the path you
would reach for is last request's sheet, and it still exists for ten minutes. This skill is
for everything *else* on paper, and for reading what went wrong when the verb failed.

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

## Per-job settings — yours to change

Pass `-o` flags on the `lp` command. This covers almost every real request ("print it in
color", "use Letter", "high quality") and needs no permission from anyone:

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

**The queue's own defaults are not yours** — "always print in gray", "default to A4" is a
host-side change, and both routes that look like they might work from here do not.
`references/errors.md` has the two dead ends and the command to hand the user instead.

## Rendering a page to PDF first

Printing a rendered page (via `agent-browser` / headless Chromium) rather than an existing
file needs two Chromium flags, and both failures are silent: see "Rendering a page to PDF
first" in `references/errors.md` before you run it.

## Checking job status

```bash
lpstat -h host.docker.internal:631 -W completed -o <queue>
```

**`lp` exiting 0 only means cupsd accepted the job** — not that it printed, and not that it
is on paper. What you can honestly say afterwards depends on the queue type, and the
difference is real: see "Did it actually print?" in `references/errors.md`.

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

## When something fails

`references/errors.md` — the error table (`lp: command not found`, the misleading
`add '/version=1.1'`, `lpadmin: Forbidden`, `client-error-not-authorized`, a stuck job),
what each one actually means, the queue-defaults dead ends, and what you can truthfully
answer when someone asks "did it print?".
