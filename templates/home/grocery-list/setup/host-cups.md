# Host CUPS

Resolve the container network's gateway IP and subnet, install CUPS, and configure
`cupsd.conf` to listen on that gateway with a subnet-scoped ACL. Idempotent — safe to re-run
from the top.

**Everything with `sudo` in it goes to the operator.** Print the block, ask them to run it in
their own terminal (`! <command>` in Claude Code), and wait for them to say it is done. The
probes in step 1 are read-only and yours to run.

## 1. Resolve the network, gateway IP, and subnet

Every command block below is a fresh shell — re-derive these three values at the top of each
one; don't assume they survive from a previous `Bash` call.

```bash
NET=$(grep -E '^NANOCLAW_NETWORK=' .env | cut -d= -f2)
if [ -z "$NET" ]; then
  echo "NANOCLAW_NETWORK unset — containers use Docker's default bridge, subnet 172.17.0.0/16"
  NET=bridge
  SUBNET="172.17.0.0/16"
else
  SUBNET=$(docker network inspect "$NET" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
fi

GATEWAY_IP=$(docker run --rm --network "$NET" --add-host=host.docker.internal:host-gateway \
  busybox grep host.docker.internal /etc/hosts | awk '{print $1}')

[ -n "$GATEWAY_IP" ] && [ -n "$SUBNET" ] || { echo "ABORT: could not resolve gateway/subnet"; exit 1; }
echo "GATEWAY_IP=$GATEWAY_IP SUBNET=$SUBNET"
```

`$NET` must never reach `docker run --network ""` — that fails outright with `docker: no name
set for network`, which would abort the probe on the exact configuration the fallback above
exists to support. Defaulting `NET=bridge` in the same branch as the `SUBNET` fallback keeps
the two in sync: `--network bridge` returns `172.17.0.1`, which is inside `172.17.0.0/16`.

BusyBox has no `getent`, and `busybox nslookup` doesn't work either — the Docker embedded
resolver doesn't serve `--add-host` entries — so read `/etc/hosts` directly with `grep`.

Do not assume the gateway is the network's own subnet gateway. NanoClaw passes
`--add-host=host.docker.internal:host-gateway` and lets Docker pick, which on Linux is
commonly the *default* bridge gateway (e.g. `172.17.0.1`), not the user-defined network's own
subnet gateway (e.g. `172.24.0.1`). The probe above resolves the real value empirically
rather than guessing.

Both values are used only within this file. No later step needs either — but note them down
anyway: the troubleshooting rows in `printing.md` and `caveats.md` refer to them.

## 2. Install CUPS

```bash
systemctl is-active cups 2>/dev/null || echo "not-active"
```

If `active`, CUPS is already running — skip the install but still check the `cupsd.conf`
edits below are present (grep before assuming).

For the operator:

```bash
sudo apt-get update
sudo apt-get install -y cups cups-ipp-utils
```

`cups-ipp-utils` provides `ipptool`/`ippfind`, used for identification in `printer-setup.md`.
Do not install `cups-browsed` — it is deprecated in current CUPS and nothing here depends on
mDNS auto-discovery.

## 3. Configure `cupsd.conf`

For the operator. Back up the config once, before any edit, to this exact path:

```bash
sudo test -f /etc/cups/cupsd.conf.pre-grocery-list || \
  sudo cp /etc/cups/cupsd.conf /etc/cups/cupsd.conf.pre-grocery-list
```

Then the listen address and the job ceilings. `GATEWAY_IP` and `SUBNET` come from step 1 —
substitute the real values into the block you hand over, since the operator's shell will not
have them (grep-then-append, never blind-append: re-running must not duplicate lines, and an
empty value must never reach `sed`):

```bash
GATEWAY_IP=<from step 1>
SUBNET=<from step 1>
[ -n "$GATEWAY_IP" ] && [ -n "$SUBNET" ] || { echo "ABORT: GATEWAY_IP/SUBNET not set"; exit 1; }

STALE_LISTEN=$(grep -E '^Listen[[:space:]]+[0-9]' /etc/cups/cupsd.conf | grep -v '127\.0\.0\.1:631' || true)

if grep -qF "Listen ${GATEWAY_IP}:631" /etc/cups/cupsd.conf; then
  echo "Listen line already correct for ${GATEWAY_IP}"
elif [ -n "$STALE_LISTEN" ]; then
  echo "stale gateway Listen line found — rewriting to ${GATEWAY_IP}"
  sudo sed -i -E "/^Listen[[:space:]]+(localhost|127\.0\.0\.1):631/! s|^Listen[[:space:]]+[0-9.]+:631|Listen ${GATEWAY_IP}:631|" /etc/cups/cupsd.conf
elif grep -qE '^Listen[[:space:]]+(localhost|127\.0\.0\.1):631' /etc/cups/cupsd.conf; then
  sudo sed -i -E "/^Listen[[:space:]]+(localhost|127\.0\.0\.1):631/a Listen ${GATEWAY_IP}:631" /etc/cups/cupsd.conf
else
  echo "Listen ${GATEWAY_IP}:631" | sudo tee -a /etc/cups/cupsd.conf >/dev/null
fi

grep -qE '^MaxRequestSize' /etc/cups/cupsd.conf || \
  echo "MaxRequestSize 50m" | sudo tee -a /etc/cups/cupsd.conf >/dev/null
grep -qE '^MaxJobs ' /etc/cups/cupsd.conf || \
  echo "MaxJobs 20" | sudo tee -a /etc/cups/cupsd.conf >/dev/null
grep -qE '^MaxJobsPerPrinter' /etc/cups/cupsd.conf || \
  echo "MaxJobsPerPrinter 5" | sudo tee -a /etc/cups/cupsd.conf >/dev/null
```

Three cases, not two: the current gateway line is already there (no-op); a *different*
numeric `Listen` line exists — left over from a docker network that was recreated with a new
gateway — and gets rewritten in place rather than left to rot alongside a fresh one; or
neither exists yet, in which case the localhost anchor (`localhost:631` or `127.0.0.1:631`,
possibly absent entirely) gets a line appended after it, or at top level if that anchor is
missing too.

`MaxRequestSize` (not `MaxJobSize`, which is not a real CUPS directive) plus `MaxJobs` /
`MaxJobsPerPrinter` are unbypassable ceilings enforced by cupsd itself, not by anything an
agent can spoof — they are the real defence against a runaway or oversized print job. See
`caveats.md` #3.

### The alias, and the error it prevents

Binding to the gateway is not enough on its own: cupsd also validates the HTTP `Host:` header
against its own known names (DNS-rebinding protection) and answers **400 Bad Request** to
anything else. Containers address cupsd as the literal `host.docker.internal`, which is not
one of those names, so without an alias every container-side `lp`/`lpstat` fails no matter
how correct `Listen` and the ACL are. This line is a fixed literal — no variable to
substitute:

```bash
grep -qE '^ServerAlias[[:space:]]+host\.docker\.internal' /etc/cups/cupsd.conf || \
  echo "ServerAlias host.docker.internal" | sudo tee -a /etc/cups/cupsd.conf >/dev/null
```

Add the one name, not `ServerAlias *` — the wildcard switches the protection off for every
host header, a much wider change than this needs. The failure it prevents is worth
recognising on sight: `lp` reports `Error - add '/version=1.1' to server name`, which reads
like an IPP version mismatch and points nowhere near a rejected `Host:` header. The same
request sent to the gateway **IP** returns 200, which is the quickest way to confirm the
diagnosis. It is also the row the template's `skills/printing/references/errors.md` carries,
so the agent recognises it too.

### The ACL

Add an `Allow` line inside the root `<Location />` block scoped to the container subnet. Do
**not** touch `<Location /admin>` — leave that localhost-only.

```bash
SUBNET=<from step 1>
grep -qE '^[[:space:]]*Order[[:space:]]+allow,deny' /etc/cups/cupsd.conf || \
  sudo sed -i "/<Location \/>/a\\  Order allow,deny" /etc/cups/cupsd.conf

if grep -qF "Allow from ${SUBNET}" /etc/cups/cupsd.conf; then
  echo "ACL already correct for ${SUBNET}"
elif grep -qE '^[[:space:]]*Allow from [0-9]' /etc/cups/cupsd.conf; then
  echo "stale Allow line found — rewriting to ${SUBNET}"
  sudo sed -i "s|^\([[:space:]]*\)Allow from [0-9].*|\1Allow from ${SUBNET}|" /etc/cups/cupsd.conf
else
  sudo sed -i "/<Location \/>/a\\  Allow from ${SUBNET}" /etc/cups/cupsd.conf
fi
```

`Order` and `Allow` are guarded independently: Ubuntu's shipped `cupsd.conf` usually already
carries `Order allow,deny` in `<Location />`, so that line is typically a no-op and never gets
duplicated. `Allow` gets a genuine three-way check — correct / stale / absent — so a docker
network recreated with a different subnet is actually repaired on re-run instead of the old
`Allow from <old-subnet>` line surviving forever. A plain "does *some* Allow line exist" guard
would match the stale line and skip the rewrite, which is the bug this shape avoids.

### Validate and restart

`cupsd -t` exits 0 even when a directive is unknown, so grep its own output rather than
trusting `$?`:

```bash
OUT=$(sudo cupsd -t -c /etc/cups/cupsd.conf 2>&1)
echo "$OUT"
echo "$OUT" | grep -qi 'Unknown directive' && echo "CONFIG INVALID — check the edits above" || echo "config OK"

sudo systemctl enable --now cups
systemctl is-active cups
sudo ss -lntp | grep ':631'   # must show both 127.0.0.1:631 (or localhost) and the gateway
```

If the gateway line is missing from `ss` output, the `Listen` edit did not take — re-check the
anchor match and re-apply. Any *other* `<ip>:631` address that is neither localhost nor the
current gateway is a stale line the rewrite did not recognise (hand-edited, or oddly
formatted): remove it by hand and `sudo systemctl restart cups`.

If *no* localhost address appears at all, add `Listen localhost:631` back and restart.
Host-side `lp`/`lpadmin` reach cupsd over `/run/cups/cups.sock` so they keep working either
way, but the localhost listener should be there.

`avahi-daemon` may be inactive on this host, meaning mDNS/`ippfind` discovery will not find
printers on its own. That is fine — identification in `printer-setup.md` is IP-based.

---

Host CUPS is now listening and ACL'd. Continue with `printer-setup.md`.
