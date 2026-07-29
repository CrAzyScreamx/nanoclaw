# Remove printer access

Idempotent — safe to run even if some steps were never applied.

This skill leaves **host-side state that is not in the repo**: the `cups` system
service, a hand-edited `/etc/cups/cupsd.conf`, and a CUPS print queue. None of that
is reversed by a `git revert` — removal here is operator prose against the live
host, not a code change.

## 1. Revoke agent group access

Find which groups were granted printing. For each candidate:

```bash
ncl groups list
ncl groups config get --id <group-id>     # look for cups-client under packages_apt
```

For every group with `cups-client` present:

```bash
ncl groups config remove-package --id <group-id> --apt cups-client
ncl groups config get --id <group-id>     # re-check packages_apt
```

If `packages_apt`/`packages_npm` are now **empty**, do not use `--rebuild` —
`buildAgentGroupImage` errors on an empty package list, so the rebuild never runs
and the derived image keeps `lp`. Note `image_tag` from the `config get` above
(e.g. `<CONTAINER_IMAGE_BASE>:<group-id>`) *before* clearing it, then fall back to
the base image:

```bash
ncl groups config update --id <group-id> --image-tag ''
ncl groups restart --id <group-id>
docker rmi <CONTAINER_IMAGE_BASE>:<group-id>   # optional, reclaims the orphaned image
```

If **other** apt/npm packages remain after removing `cups-client`, use
`--rebuild` instead so the image is regenerated without `lp`:
`ncl groups restart --id <group-id> --rebuild`.

Either way one of the two restart paths is required — `remove-package` alone
only edits the DB row and leaves the already-built image untouched.

## 2. Remove the container skill

```bash
rm -rf container/skills/printing
```

Safe to run whether or not the directory exists. This alone does not affect a
**running** container — skills sync at spawn, so a live container keeps the
printing skill until it restarts: `ncl groups restart --id <group-id>`.

## 3. Delete the print queue

```bash
lpstat -p                    # list queues, confirm the name before deleting
sudo lpadmin -x <queue>
```

A no-op (with a harmless error) if the queue was never created or already removed.

## 4. Revert the cupsd config and restart CUPS

```bash
if sudo test -f /etc/cups/cupsd.conf.pre-add-printers; then
  sudo cp /etc/cups/cupsd.conf.pre-add-printers /etc/cups/cupsd.conf
  sudo systemctl restart cups
else
  echo "no backup found — edit /etc/cups/cupsd.conf by hand, see below"
fi
```

If the backup is missing, edit `/etc/cups/cupsd.conf` by hand and remove exactly
what the install phase added:

- any `Listen <ip>:631` line whose address is **not** `localhost`/`127.0.0.1` —
  that's the one this skill added. Leave an original localhost line alone; if
  there was never one, don't add it.
- the `Allow from <subnet>` line inside `<Location />`, and the `Order
  allow,deny` line above it **only if** it isn't in the shipped default (diff
  against `/etc/cups/cupsd.conf.pre-add-printers` if it still exists elsewhere;
  otherwise leave `Order allow,deny` — removing `Allow` with no `Order` denies
  everything, including localhost).
- the `ServerAlias host.docker.internal` line
- the `MaxRequestSize`, `MaxJobs`, and `MaxJobsPerPrinter` directives

Then `sudo systemctl restart cups`.

## 5. (Optional) Remove CUPS entirely

Only with explicit operator confirmation that nothing else on this host prints —
this is a shared system service, not something the skill owns exclusively:

```bash
sudo systemctl disable --now cups
sudo apt-get purge cups cups-ipp-utils
dpkg -l snmp >/dev/null 2>&1 && sudo apt-get purge snmp   # if SNMP identification installed it
```
