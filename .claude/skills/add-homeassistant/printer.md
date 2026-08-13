# Printer

Needs `HA_URL`, `HA_TOKEN`, `AUTH_MODE`, and the `hac` / `haget` / `hapost` helpers from
`connect.md`. Ends with a `printers` block for `services.json` and the list of agent groups that
get it, handed to `enable.md`.

**A printer is the read-mostly one.** The vacuum and the car are machines you tell to do
something; a printer in Home Assistant is a set of sensors — status, ink or toner levels, page
counts — and **no way to print**. No Home Assistant printer integration exposes a `print`
service, and none exposes the job queue. So this phase is about *monitoring*: the tools it
produces answer "how much ink is left", "is it online", and "why won't it print".

Say that boundary out loud to the user, because it is the one thing they are likely to assume
wrongly — enabling this does not give the agent a way to put a document on paper. This service
is self-contained and knows nothing about how, or whether, anything on this install prints.

Not to be confused with **3D printers**. OctoPrint and PrusaLink are separate Home Assistant
integrations for a different machine with different risks; this phase does not cover them.

Like `car.md`, the result is declarative — a list of entities with a `kind` each — so a printer
from a different integration, or a second printer later, needs no code change.

## 1. Find the printer

Don't ask the user to hunt through the Home Assistant UI. Ask Home Assistant which entities came
from a printer integration — that is exact, where a name search is a guess:

```bash
hapost /template '{"template": "{% set ns = namespace(l=[]) %}{% for d in [\"ipp\",\"brother\",\"syncthru\",\"epsonworkforce\",\"canon\",\"hpprinter\",\"xerox\",\"escpos\"] %}{% set e = integration_entities(d) %}{% if e | count > 0 %}{% set ns.l = ns.l + [{\"integration\": d, \"entities\": e}] %}{% endif %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}"}'
```

`ipp` is the common answer — it is Home Assistant's built-in driverless integration and covers
most network printers made in the last decade, Canon and Epson included. `brother` and `syncthru`
are SNMP-based and expose more counters.

| Result | What to do |
|---|---|
| One integration, one printer's worth of entities | That's it. Go to step 2. |
| Entities from several devices | More than one printer. Each becomes its own entry in the block — the tools handle a list. Group the entities by device name before continuing. |
| `[]` | No known printer integration. Try the name sweep below before concluding there's nothing. |

If the sweep is empty, the printer may be wired through something not on that list — a template
sensor, a HACS integration, or a smart plug the user calls "the printer". Search by name:

```bash
P_MATCH=printer   # widen to the make or model — canon, brother, epson, workforce, laserjet
hapost /template "{\"template\": \"{% set ns = namespace(l=[]) %}{% for s in states %}{% if '$P_MATCH' in s.entity_id|lower or '$P_MATCH' in s.name|lower %}{% set ns.l = ns.l + [{\\\"entity_id\\\": s.entity_id, \\\"name\\\": s.name, \\\"state\\\": s.state}] %}{% endif %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}\"}"
```

Still nothing means the printer isn't in Home Assistant at all — it has to be added there first
(Settings → Devices & Services → Add Integration → the printer's make, or IPP with its IP).
Stop here in that case; there is nothing to wire and nothing to guess at.

## 2. Read what each entity actually is

The entity ids alone don't say which is the status and which is the ink. Ask for the attributes
that do — the unit, the device class, and the marker fields:

```bash
hapost /template '{"template": "{% set ns = namespace(l=[]) %}{% for e in integration_entities(\"ipp\") %}{% set s = states[e] %}{% set ns.l = ns.l + [{\"entity_id\": e, \"name\": s.name, \"state\": s.state, \"unit\": s.attributes.unit_of_measurement | default(none), \"device_class\": s.attributes.device_class | default(none), \"marker_type\": s.attributes.marker_type | default(none), \"marker_low_level\": s.attributes.marker_low_level | default(none)}] %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}"}'
```

**The `| default(none)` is load-bearing.** Reading an attribute that some entity in the loop
doesn't have renders an undefined that isn't JSON-serializable, and Home Assistant answers `400`
for the *whole* template — so one attribute-less entity loses you the entire listing rather than
one field. Swap `"ipp"` for whichever integration step 1 found.

A real answer, from a Canon TS3100 on `ipp`:

```json
[{"entity_id":"sensor.canon_ts3100_series_black","name":"Canon TS3100 series Black","state":"90","unit":"%","device_class":null,"marker_type":"ink-cartridge","marker_low_level":15},
 {"entity_id":"sensor.canon_ts3100_series","name":"Canon TS3100 series","state":"idle","unit":null,"device_class":"enum","marker_type":null,"marker_low_level":null}]
```

Sort what you got into kinds. The kind is what groups the report and what the `kind` filter
narrows on, so getting it right is what makes "how much ink is left" answerable without a page
counter attached:

| What you see | `kind` | Notes |
|---|---|---|
| `unit: "%"` with a `marker_type` | `supply` | Ink, toner, drum, maintenance box. The one people ask about. |
| A bare device-named sensor whose state is `idle` / `printing` / `stopped` | `status` | Usually `device_class: enum`. There is exactly one per printer. |
| `binary_sensor` with `device_class: connectivity` | `connectivity` | |
| Name says pages / counter / count, state is a rising integer | `counter` | Brother and SyncThru expose these; IPP doesn't. |
| Name says tray / drawer / paper | `tray` | |
| Anything else worth keeping | `other` | The default. Nothing is dropped for lacking a kind. |

Show the user what you found, with friendly names and current values, and confirm it's their
printer before continuing.

## 3. Check the readings against the printer itself

There is no equivalent of the vacuum's beep or the car's AC here — a printer has nothing this
skill can actuate that the user can see. So the confirmation is the readings themselves, checked
against the machine:

> Home Assistant says the printer is **idle**, black ink **90%**, colour ink **10%**. Does that
> match what the printer's own screen says?

That is a real end-to-end check — container → network → auth → Home Assistant → the right device
— and it catches the failure that matters here, which is having found *a* printer that isn't
theirs.

Two things to read carefully in what came back:

- **`unavailable` almost always means the printer is asleep**, not broken or misconfigured. Most
  network printers drop off in deep sleep and reappear when a job arrives. If everything is
  `unavailable`, say that, and check again after the user prints or wakes it rather than
  concluding the wiring is wrong.
- **A negative supply level is not an empty cartridge.** IPP allows `-1`, `-2` and `-3` for "this
  printer does not report a level" and Home Assistant passes them straight through. The server
  reports those as no level with a note rather than as a percentage — see step 4.

## 4. Ask which readings to enable

Each reading you include is fetched and returned; one you leave out is never fetched and never
appears. Offer them as a multi-select (`AskUserQuestion`) using the friendly names, and mark a
recommended default set.

| Reading | Recommend by default |
|---|---|
| Printer status | **Yes** — it carries the stop reason, which is the whole answer to "why won't it print" |
| Ink / toner levels | **Yes** — the most-asked question, and the one with a `low` flag |
| Drum / maintenance box | Yes, if present |
| Online / connectivity | Yes |
| Page counters | Optional — useful for "how much have we printed", noise otherwise |
| Tray / paper status | Yes, if present |
| Uptime / last seen | Rarely worth it |

Nothing here is destructive and nothing costs anything to read, so this is a much lighter
question than the car's — the reason to leave a reading out is noise in the report, not risk.

Two details worth mentioning while you ask:

- **Don't set `low_threshold`.** IPP publishes the printer's own low-water mark as
  `marker_low_level` (15% on the Canon above) and the server uses it, so a discovered printer
  usually needs no threshold at all. Set one only to deliberately overrule the printer — a user
  who wants warning at 25% rather than 15%. On an integration that publishes neither, the report
  carries the level and simply makes no `low` claim, which is the honest outcome.
- **A supply reading with no reported level** comes back as `value: null` with the raw string
  kept and a note. That's a printer that doesn't measure, not a printer that's empty.

## 5. Ask whether there is anything to *operate* — usually not

Most printers expose no actionable entity at all, and that is a fine and common answer. Skip
this step entirely if step 2 turned up nothing but sensors; a readings-only printer is a
first-class configuration and the server builds `printer_status` alone.

Where there *is* something, it is almost always one of these:

| Action | Entities | Note when asking |
|---|---|---|
| Power via a smart plug | `switch.*` the user has the printer plugged into | The common one. **Say this when asking:** cutting power mid-job loses the job, and some inkjets run an ink-wasting cleaning cycle on every power-up. |
| Restart / reset | `button.*` from the integration | One-shot, low stakes. |

Same two shapes as the car: `service` plus `off_service` for a two-state control, `service`
alone for a one-shot one. Set `label` to what a person would call it.

## 6. Assemble the block

```json
{
  "printers": [
    {
      "name": "canon",
      "label": "Canon TS3100",
      "readings": [
        { "name": "state",  "kind": "status", "label": "Printer status", "entity_id": "sensor.canon_ts3100_series" },
        { "name": "black",  "kind": "supply", "label": "Black ink",      "entity_id": "sensor.canon_ts3100_series_black" },
        { "name": "color",  "kind": "supply", "label": "Colour ink",     "entity_id": "sensor.canon_ts3100_series_color" }
      ]
    }
  ]
}
```

`name` is what the agent passes and what shows up in logs — short, lowercase, obvious. `label` is
what a person sees. Both are per printer and per reading.

Add an `actions` array alongside `readings` only if step 5 found something:

```json
{ "name": "power", "label": "Power", "entity_id": "switch.printer_plug", "service": "switch.turn_on", "off_service": "switch.turn_off" }
```

**`printers` is a list, and `enable.md` replaces it wholesale.** The merge is by top-level
service key, so re-running this phase overwrites the whole array — when you add a second printer,
emit *both* entries in the block or the first one disappears. That is the same
replace-don't-deep-merge rule the other services follow, and it is what stops a reading the user
just turned off from surviving; it just has a sharper edge on an array.

With one printer, the tools take no `printer` argument at all. With two or more they gain one,
and `printer_control` requires it — there is no sensible default when the wrong guess
power-cycles someone else's machine.

## 7. Ask which agent groups get it

```bash
ncl groups list
```

Ask which agent groups should see the printer (`AskUserQuestion` if there are several
candidates). This is the mildest of the three services — a readings-only printer exposes ink
levels and a status, and anyone who can message an enabled group can ask for them. Worth one
sentence rather than the paragraph the car needs, unless a power action is enabled, in which case
say plainly that anyone in the group can switch the printer off.

The vacuum's, car's and printer's groups don't have to match. `enable.md` merges per group.

## Carry forward

The `printers` block and the chosen group ids go to `${CLAUDE_SKILL_DIR}/enable.md`, which merges
them into whatever those groups already have rather than replacing it.
