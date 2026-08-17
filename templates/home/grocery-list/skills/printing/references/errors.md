# When printing fails — what each message actually means

Two of these read as something they are not, which is the whole reason this file exists:
`add '/version=1.1'` is not a version problem, and `The printer or class does not exist`
is usually not a wrong queue name.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `lp: command not found` | Either this agent group was never granted printing, or it was granted `cups-client` but the container is still running a stale image from before that rebuild | See **"lp is missing"** below — there is a route from inside the container, and it needs an admin's approval |
| `lpstat: Scheduler is not running.` / `lp: Error - The printer or class does not exist.` | cupsd on the host isn't reachable at `host.docker.internal:631`, or this container's subnet isn't in cupsd's ACL. **The second message names the queue but is misleading** — it's the generic error `lp` gives whenever it can't reach cupsd at all, not a sign the queue name is wrong | Host-side CUPS outage or ACL issue — report it to the user rather than hunting for a different queue name |
| `lp: Error - add '/version=1.1' to server name` (from `lp` or `lpstat`) | **Not a version mismatch.** cupsd answered **400 Bad Request** because it did not recognise the `Host: host.docker.internal` header — its DNS-rebinding protection — which happens when the host's `cupsd.conf` has no `ServerAlias host.docker.internal` line. `Listen` and the ACL can both be perfectly correct and every command still fails this way | Host-side, one line in `cupsd.conf`; the template's `setup/host-cups.md` has it. Confirm the diagnosis first by re-running the same command against the gateway **IP** instead of the name — if that works, this is it. Report it; do not go looking for an IPP version flag |
| `lpadmin: Forbidden` (or the same from `cancel -a`, `cupsdisable`, `lpmove`) | Expected, not a misconfiguration — CUPS admin operations are restricted to the host. You cannot change queue defaults, cancel other people's jobs, or disable a queue from here | Tell the user it has to be done on the host and give them the command — see **Queue defaults** below. Don't retry, and don't look for another way in |
| `client-error-not-authorized` | CUPS access control (ACL) is rejecting this request — the container's source IP is outside the `Allow from <subnet>` line, which drifts when the docker network is recreated | Host-side CUPS policy issue — report it to the user rather than retrying |
| Job accepted but stuck in queue (never shows `completed`) | Printer offline, out of paper/toner (if the queue surfaces state), or a stalled backend | Check `lpstat -h host.docker.internal:631 -l -p <queue>` for `printer-state-reasons`; if it's a `socket://` queue there may be nothing to see — report the stuck job to the user |

## lp is missing

`cups-client` is what puts `lp` and `lpstat` in this container, and it is added per agent
group. If it was never added — printing was declined at setup, or this group was created
later — there is one route from in here, and it is not free:

```
install_packages({ apt: ["cups-client"], reason: "the group asked for the list on paper" })
```

That raises an approval card to an admin. On approve, the config is updated **and** the
image is rebuilt in the same step, the container restarts, and a follow-up prompt arrives
telling you to verify. You will not see the answer inside the current turn, so say what you
have asked for and stop. If it is denied, explain what was denied and do not retry.

Do not reach for `ncl groups config add-package` instead. It also needs approval and it only
records the package — nothing rebuilds, so `lp` is still missing afterwards with nothing to
indicate why.

**This fixes only the container half.** If the host has no CUPS, no queue, or no
`ServerAlias`, `lp` will now exist and still fail — that half is the operator's, in the
template's `SETUP.md` (`setup/printing.md`, `setup/host-cups.md`, `setup/printer-setup.md`).

## Queue defaults are not yours

When asked to make something the default from now on ("always print in gray", "default to
A4"), do not try to do it. Two dead ends, both of which look like they might work:

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
only want it for the job in front of them, use the per-job `-o` flags in `SKILL.md` instead —
that's usually what "make it color" actually means, and it needs nobody's involvement.

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

(The shopping-list sheet needs none of this. `grocery.ts printable` renders it through the
same headless Chromium with the flags already right.)

## Did it actually print?

**Be honest with the user about what job status does and doesn't tell you.** `lp` exiting 0
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
