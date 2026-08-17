# Printer setup

Identify the printer over IPP, create a driverless queue, set the queue defaults, print a test
page, and get a human to confirm paper came out. Idempotent — safe to re-run. Needs host CUPS
already installed and configured (`host-cups.md`).

**Everything with `sudo` in it goes to the operator** — print the block, ask them to run it in
their own terminal (`! <command>` in Claude Code), and wait. The probes and the `lpstat` /
`lpoptions` reads are yours.

Every command block below is a fresh shell — re-derive `IP`, `RESOURCE` and `Q` at the top of
each one; don't assume they survive from a previous `Bash` call.

## 1. Identify the printer

### Ask for the printer's address

Ask the operator for the printer's IP address or hostname on the local network. There is no
way to discover this automatically without a working mDNS setup, so this one is a genuinely
manual input.

### Reachability probe

```bash
IP=<the address they gave>
for port in 631 9100 515; do
  timeout 2 bash -c "echo > /dev/tcp/$IP/$port" 2>/dev/null && echo "port $port open" || echo "port $port closed/filtered"
done
```

Port 631 open means IPP is available — try that first. 9100 open with 631 closed means
raw-socket printing only (see the fallback in step 2). 515 is LPD, a last resort.

### Identify over IPP

The IPP Everywhere default resource path is `/ipp/print`, but some devices answer only on
`/ipp/printer` or an indexed `/ipp/print/<n>` — try in order and use the first that responds.
Each attempt is capped at 15s: against a filtered or black-holed address `ipptool` does not
return on its own.

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
- `document-format-supported` — look for `image/urf` or `application/pdf`; either means the
  printer supports **IPP Everywhere** (driverless, no PPD needed). The sheet this template
  prints is a PDF, so `application/pdf` is the format that matters
- `media-supported`, `sides-supported`, `color-supported` — capabilities worth knowing before
  the queue is created

### Fallbacks, in order, only if IPP identification fails

```bash
IP=<the printer's address>

# SNMP (needs the `snmp` package — install it only if you reach this step)
snmpget -v2c -c public "$IP" 1.3.6.1.2.1.25.3.2.1.3.1

# HTTP embedded web server title
curl -s --max-time 5 "http://$IP/" | grep -io '<title>.*</title>'
```

If both come back empty, ask for the printer's make and model directly — last resort, not the
first move. If `ipptool`/`ippfind` found nothing at all, that is usually `avahi-daemon` being
inactive on this host; it is not a blocker, since identification here is IP-based.

## 2. Create the queue

For the operator. Try driverless first — nearly every printer made since ~2015 supports IPP
Everywhere and needs no driver install at all:

```bash
IP=<the printer's address>
RESOURCE=<the resource path that answered in step 1, e.g. /ipp/print>
Q=<a short queue name, e.g. the printer's room or model, no spaces>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
sudo lpadmin -p "$Q" -E -v "ipp://$IP$RESOURCE" -m everywhere -o printer-is-shared=true
sudo lpadmin -d "$Q"          # optional: make it the default queue
```

`-o printer-is-shared=true` matters: cupsd refuses remote access to an unshared queue, and
every agent container is a remote client. `DefaultShared` is Yes by default today, but setting
it explicitly means this does not break on a host where that default was ever changed.

Making it the **default** queue is worth doing if this is the only printer: it is what lets
`grocery.ts print` resolve a queue with nobody naming one.

Verify (yours, read-only):

```bash
Q=<the queue name>
lpstat -l -p "$Q"
lpoptions -p "$Q" -l
```

### If `-m everywhere` fails

Only then fall back by vendor: HP printers → `sudo apt-get install -y hplip`, then re-run
`lpadmin` with the HP driver; most other vendors → `sudo apt-get install -y
printer-driver-gutenprint` (or `printer-driver-all` for the broadest coverage); as a last
resort a vendor-supplied PPD:

```bash
sudo lpadmin -p "$Q" -E -v "ipp://$IP$RESOURCE" -i /path/to/driver.ppd -o printer-is-shared=true
```

`-i <ppd-file>` is the current documented spelling (`-P` is accepted but deprecated).

If the printer only exposed port 9100 (raw socket, no IPP), the queue has to be
`-v socket://$IP:9100` instead. Say so plainly: **a `socket://` queue has no back-channel** —
CUPS marks the job `completed` the moment bytes are sent over the socket, so out-of-paper,
jams and similar conditions never surface. Only a driverless/IPP queue gets real status back.

## 3. Set the queue defaults

A driverless queue's defaults are whatever the generated PPD picked, and **every agent job
that passes no `-o` flags inherits them** — silently, on paper. Ask now rather than letting
the operator discover the choice one page at a time. On an inkjet the colour default is a
recurring physical cost.

Read what the queue actually offers first — never guess from the model name. `*` marks the
current default:

```bash
Q=<the queue name>
lpoptions -p "$Q" -l
```

Ask about the ones they plausibly have an opinion on — paper size, colour mode, print quality
— and leave the rest alone. Only offer choices that appear in that output: a printer whose
`sides-supported` is `one-sided` has no `Duplex` line at all, and `-o
sides=two-sided-long-edge` sent to it is quietly ignored rather than refused.

The list is A4 by default, which is what the sheet is laid out for. If this printer is
letter-only, set `PageSize=Letter` here — the renderer will still produce A4 and CUPS will
scale it, so a mismatch costs margins rather than a failed job.

For the operator:

```bash
sudo lpadmin -p "$Q" -o ColorModel=Gray -o cupsPrintQuality=Normal -o PageSize=A4
```

`lpadmin -o` is the one that works here: it writes the **printer's own** defaults on the
server, which is exactly what a remote client gets when it submits with no options.
`lpoptions -o` reads almost identically but writes `~/.cups/lpoptions` for **local** clients
only; set defaults that way and container jobs keep the old ones with nothing to indicate why.

Verify by re-reading the server's PPD — that is the actual proof the defaults reach agent
jobs:

```bash
lpoptions -p "$Q" -l | grep -E 'ColorModel|cupsPrintQuality|PageSize'
```

These are defaults, not limits: an agent can still override any of them per job, and the
`printing` skill documents `-o`.

## 4. Test page, and a human confirming it

**Ask before sending this — and before every job after it.** A print job is a physical side
effect: paper, ink, and noise somewhere nobody may be. Confirm the printer is loaded and that
now is a fine time, then submit. A yes here covers *this* job only; if debugging leads to a
second or third page, ask again each time.

There is no `testprint` sample file on modern Ubuntu (`/usr/share/cups/data/` is empty) —
print via stdin instead. Assert `Q` is set before touching `lp`: an empty `-d ""` fails with
`The printer or class does not exist`, which misleadingly reads as "the queue is missing"
rather than "the variable is unset".

```bash
Q=<the queue name>
[ -n "$Q" ] || { echo "ABORT: queue name not set"; exit 1; }
printf 'NanoClaw printer test\n' | lp -d "$Q" -t grocery-list-test
lpstat -W completed -o "$Q"
lpstat -l -p "$Q"
```

`printer-state-reasons` in that last command is where problems like `media-empty-error` or
`toner-low` show up — only for a queue with a real back-channel, per the `socket://` caveat
above.

**Ask whether the page physically came out** — "yes, printed fine" / "no, nothing printed" /
"printed but garbled". A `completed` job status only means cupsd sent the bytes; it is not
proof of paper. On "no" or "garbled", stop here and work the error table in the template's
`skills/printing/references/errors.md` rather than continuing to part 3 of `printing.md`.
