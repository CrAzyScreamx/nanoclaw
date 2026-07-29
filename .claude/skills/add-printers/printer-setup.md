# Printer Setup

Identify the printer over IPP, create a driverless print queue, print a test page, and get
the user to confirm paper came out. Idempotent — safe to re-run. Needs host CUPS already
installed and configured — see `.claude/skills/add-printers/host-cups.md`.

Every command block below is a fresh shell — re-derive `IP`, `RESOURCE`, and `Q` at the top
of each one; don't assume they survive from a previous `Bash` call.

## 1. Identify the printer

### Ask for the printer's address

Use `AskUserQuestion` (or plain conversation) to get the printer's IP address or hostname
on the local network. There's no way to discover this automatically without a working
mDNS setup, so this one is a genuinely manual input.

### Reachability probe

```bash
IP=<the address the user gave>
for port in 631 9100 515; do
  timeout 2 bash -c "echo > /dev/tcp/$IP/$port" 2>/dev/null && echo "port $port open" || echo "port $port closed/filtered"
done
```

Port 631 open means IPP is available (try this first). 9100 open with 631 closed means
raw-socket printing only (see the fallback in step 2). 515 is LPD, a last resort.

### Identify over IPP

The IPP Everywhere default resource path is `/ipp/print`, but some devices answer only on
`/ipp/printer` or an indexed `/ipp/print/<n>` — try in order and use the first that
responds. Each attempt is capped at 15s — against a filtered or black-holed address
`ipptool` does not return on its own:

```bash
IP=<the printer's address>
for path in /ipp/print /ipp/printer /ipp/print/1; do
  echo "trying ipp://$IP$path"
  timeout 15 ipptool -tv "ipp://$IP$path" get-printer-attributes.test && { RESOURCE="$path"; break; }
done
```

Read the output for:
- `printer-make-and-model` — what the printer is
- `ipp-versions-supported` — confirms IPP is live
- `document-format-supported` — look for `image/urf` or `application/pdf`; either means
  the printer supports **IPP Everywhere** (driverless printing, no PPD needed)
- `media-supported`, `sides-supported`, `color-supported` — capabilities worth knowing
  before the queue is created

### Fallbacks, in order, only if IPP identification fails

```bash
IP=<the printer's address>

# SNMP (needs `snmp` package — install it only if you reach this step)
snmpget -v2c -c public "$IP" 1.3.6.1.2.1.25.3.2.1.3.1

# HTTP embedded web server title
curl -s --max-time 5 "http://$IP/" | grep -io '<title>.*</title>'
```

If both come back empty, ask the user for the printer's make and model directly — this is
the last resort, not the first move.

If `ipptool`/`ippfind` found nothing at all in step 1, that's usually `avahi-daemon` being
inactive on this host — mDNS discovery doesn't work without it. It isn't a blocker:
identification here is IP-based, so just confirm you're using the printer's actual IP
rather than relying on discovery.

## 2. Create the queue

Try driverless first — nearly every printer made since ~2015 supports IPP Everywhere and
needs no driver install at all:

```bash
IP=<the printer's address>
RESOURCE=<the resource path that answered in step 1, e.g. /ipp/print>
Q=<a short queue name, e.g. the printer's room or model, no spaces>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
sudo lpadmin -p "$Q" -E -v "ipp://$IP$RESOURCE" -m everywhere -o printer-is-shared=true
```

`-o printer-is-shared=true` matters: cupsd refuses remote access to an unshared queue.
`DefaultShared` is Yes by default today, but setting it explicitly means this doesn't break
on a host where that default was ever changed.

Optionally set it as the default (re-derive `Q` — fresh shell):

```bash
Q=<the queue name from above>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
sudo lpadmin -d "$Q"
```

Verify (re-derive `Q` again):

```bash
Q=<the queue name from above>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
lpstat -l -p "$Q"
lpoptions -p "$Q" -l
```

### If `-m everywhere` fails

Only then fall back by vendor: HP printers → `sudo apt-get install -y hplip` then re-run
`lpadmin` with the HP driver; most other vendors → `sudo apt-get install -y
printer-driver-gutenprint` (or `printer-driver-all` for the broadest coverage); as a last
resort, a vendor-supplied PPD via (re-derive `IP`, `RESOURCE`, `Q`):

```bash
IP=<the printer's address>
RESOURCE=<the resource path from step 1>
Q=<the queue name from above>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
sudo lpadmin -p "$Q" -E -v "ipp://$IP$RESOURCE" -i /path/to/driver.ppd -o printer-is-shared=true
```

`-i <ppd-file>` is the current documented spelling (`-P` is accepted but emits a
deprecation warning — use `-i`).

If the printer only exposed port 9100 (raw socket, no IPP) in step 1's probe, the queue
has to be `-v socket://$IP:9100` instead. Tell the user plainly: **a `socket://` queue has
no back-channel** — CUPS marks the job `completed` the moment bytes are sent over the
socket, so out-of-paper, jams, and similar conditions never surface. Only a driverless/IPP
queue gets real status back.

## 3. Set the queue defaults

A driverless queue's defaults are whatever the generated PPD picked, and **every agent job
that passes no `-o` flags inherits them** — silently, on paper. Ask now rather than letting
the user discover the choice one page at a time. On an inkjet the color default is a
recurring physical cost, which makes this worth a question even though nothing is broken
without it.

Read what the queue actually offers first — never guess from the model name (re-derive `Q`,
fresh shell):

```bash
Q=<the queue name from step 2>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
lpoptions -p "$Q" -l
```

Each line is one option with its choices; the current default carries a `*`. Ask the user
about the ones they plausibly have an opinion on — paper size, color mode, print quality —
and leave the rest alone. Only offer choices that appear in that output: a printer whose
`sides-supported` is `one-sided` has no `Duplex` line at all, and a `-o
sides=two-sided-long-edge` sent to it is quietly ignored rather than refused. Where it
matters, confirm against the device itself with a `Get-Printer-Attributes` query for
`sides-supported` / `print-color-mode-supported` / `media-default` rather than trusting the
PPD to have mirrored it.

Apply the answers (re-derive `Q` again):

```bash
Q=<the queue name from step 2>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
sudo lpadmin -p "$Q" -o ColorModel=Gray -o cupsPrintQuality=Normal -o PageSize=A4
```

`lpadmin -o` is the one that works here: it writes the **printer's own** defaults on the
server, which is exactly what a remote client gets when it submits with no options — and
every agent container is a remote client. `lpoptions -o` reads almost identically but
writes `~/.cups/lpoptions` (or `/etc/cups/lpoptions`) for **local** clients only; set
defaults that way and container jobs keep the old ones with nothing to indicate why.

Verify the way a container sees it, not the way the host does — re-reading the server's PPD
is the actual proof the defaults will reach agent jobs:

```bash
Q=<the queue name from step 2>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
lpoptions -p "$Q" -l | grep -E 'ColorModel|cupsPrintQuality|PageSize'
```

Tell the user these are defaults, not limits — an agent can still override any of them per
job (`-o ColorModel=RGB`), and the `printing` container skill already documents `-o`.

## 4. Test page and human confirmation

**Ask before sending this — and before every job after it.** A print job is a physical
side effect: paper, ink, and noise somewhere the user may not be. Confirm the printer is
loaded and that now is a fine time, then submit. A yes here covers *this* job only; if
debugging leads you to send a second or third page, ask again each time rather than
treating the first confirmation as standing permission.

There's no `testprint` sample file shipped on modern Ubuntu (`/usr/share/cups/data/` is
empty) — print via stdin instead. Re-derive `Q` (fresh shell) and assert it's set before
touching `lp` — an empty `-d ""` fails with `The printer or class does not exist`, which
misleadingly reads as "the queue is missing" rather than "the variable is unset":

```bash
Q=<the queue name from step 2>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
printf 'NanoClaw printer test\n' | lp -d "$Q" -t nanoclaw-test
```

Note the returned request id (`<queue>-<n>`), then poll (re-derive `Q` again):

```bash
Q=<the queue name from step 2>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
lpstat -W completed -o "$Q"
lpstat -l -p "$Q"
```

The second command's `printer-state-reasons` field is where problems like
`media-empty-error` or `toner-low` show up (only for a queue with a real back-channel —
see the `socket://` caveat above).

**Ask the user to confirm the page physically came out** — use `AskUserQuestion` with
options like "yes, printed fine" / "no, nothing printed" / "printed but garbled". A
`completed` job status only means cupsd sent the bytes; it is not proof of paper. On "no"
or "garbled," go to the Troubleshooting table in `SKILL.md` rather than continuing to
`.claude/skills/add-printers/agent-access.md`.
