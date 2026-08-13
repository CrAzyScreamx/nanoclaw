# BYD Vehicle

Needs `HA_URL`, `HA_TOKEN`, `AUTH_MODE`, and the `hac` / `haget` / `hapost` helpers from
`connect.md`. Ends with a `car` block for `services.json` and the list of agent groups that get
it, handed to `enable.md`.

Unlike the vacuum — one machine, one entity, a fixed set of services — a car in Home Assistant
is a **collection** of entities from several domains: a `climate` or `switch` for the AC, a
`lock` for the doors, `sensor`s for battery and charge state, a `device_tracker` for location.
Which ones exist depends entirely on the integration the user has. So this phase discovers what
is actually there and asks the user to map it, rather than assuming an entity naming scheme
that would be wrong on the next integration.

The result is two lists in `services.json`: **actions** (things the agent can do to the car) and
**readings** (things the agent can find out about it). Both are declarative — an action is a
`domain.service` plus an entity id — so a different BYD integration, or a different car
entirely, needs no code change.

## 1. Find the car's entities

Ask Home Assistant for everything whose entity id or friendly name looks like the car. Start
with `byd`, and widen if it comes back thin — some integrations name entities after the model
(`atto3`, `dolphin`, `seal`) or after whatever the user called the vehicle:

```bash
CAR_MATCH=byd    # widen to the model name or the user's name for the car if this is empty
hapost /template "{\"template\": \"{% set ns = namespace(l=[]) %}{% for s in states %}{% if '$CAR_MATCH' in s.entity_id|lower or '$CAR_MATCH' in s.name|lower %}{% set ns.l = ns.l + [{\\\"entity_id\\\": s.entity_id, \\\"name\\\": s.name, \\\"state\\\": s.state}] %}{% endif %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}\"}"
```

| Result | What to do |
|---|---|
| A list of entities | Good. Group them by domain and read on. |
| `[]` | Nothing matched. Widen `CAR_MATCH`, or list the interesting domains directly (below). If still nothing, ask the user for the entity ids; if they don't have any, the integration isn't set up and they have to add the car in Home Assistant first. Stop here in that case. |
| `401` | Token wrong or expired — redo step 3 of `connect.md`. |

If the name search comes up empty, sweep the domains a car uses and let the user point at the
right ones:

```bash
for D in climate lock switch button device_tracker binary_sensor; do
  echo "--- $D ---"
  hapost /template "{\"template\": \"{% set ns = namespace(l=[]) %}{% for s in states.$D %}{% set ns.l = ns.l + [{\\\"entity_id\\\": s.entity_id, \\\"name\\\": s.name, \\\"state\\\": s.state}] %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}\"}"
done
```

`sensor` is left out of that loop on purpose — a typical install has hundreds, and the name
search above is the better tool for finding the car's. If you need it, run the same call with
`states.sensor` and a name filter.

Show the user what you found, grouped by domain and using friendly names, and confirm these
entities are their car before continuing. More than one vehicle on one Home Assistant is common
enough to be worth one question.

## 2. Test the connection — after asking

The test is turning on the AC, because it is the one action whose effect the user can verify
and that undoes itself. Identify the candidate first — usually a `climate.*` entity, sometimes
a `switch.*` named for climate or preconditioning:

```bash
CAR_AC_ENTITY="climate.byd_atto3_hvac"    # <- the entity the user confirmed
haget "/states/$CAR_AC_ENTITY" | head -c 600; echo
```

Read the `state` before doing anything. `unavailable` means the car is asleep or out of signal
and the call will be accepted and do nothing — say so and ask them to wake the car (the BYD app
usually does it) rather than sending a command you already know is going nowhere. If it is
already `on` / `heat` / `cool`, note that too, so "it was already running" doesn't get read as
a successful test.

Then ask — every time, including on a re-run:

> To check the connection I'd like to turn on the car's air conditioning. It's the one action I
> can do that you can actually see happen, and you can turn it off again from the app. It will
> draw some battery. Shall I?

Only once they say yes. Pick the service that matches the entity's domain — `climate.turn_on`
for a `climate` entity, `switch.turn_on` for a `switch`:

```bash
hapost /services/climate/turn_on "{\"entity_id\": \"$CAR_AC_ENTITY\"}"
```

Then ask the user directly: **did the car's AC come on?**

`200` means Home Assistant accepted and dispatched the call — nothing more. Cars are worse than
vacuums here: the command goes to the manufacturer's cloud and then to a vehicle that may be
asleep, so acceptance and effect can be minutes apart or never. Give it a moment before
concluding it failed, and re-read the state:

```bash
haget "/states/$CAR_AC_ENTITY" | head -c 600; echo
```

**Turn it back off once they've confirmed**, unless they say to leave it:

```bash
hapost /services/climate/turn_off "{\"entity_id\": \"$CAR_AC_ENTITY\"}"
```

Leaving a test running in someone's car is not a neutral default — it drains the battery and
nobody asked for a warm car right now.

### When the AC doesn't come on

| Symptom | Cause |
|---|---|
| `200`, state stays `off`, entity was `unavailable` | The car is asleep or has no signal. Wake it and retry. |
| `200`, state stays `off`, entity was live | The integration accepted a command the car refused — often because the car is unplugged, below a battery threshold, or not in a state that permits remote climate. Check the BYD app; this is a car-side rule, not a NanoClaw problem. |
| `400` with `not a valid value ... entity_id` | Wrong entity id, or the domain doesn't match the service (`climate.turn_on` against a `switch.*` entity). Re-check step 1. |
| `401` | Token wrong or expired — redo step 3 of `connect.md`. |
| `500` | The integration errored. Check Home Assistant's own logs (Settings → System → Logs). |

Don't continue until the user confirms the AC responded, or you've established it's a car-side
restriction and verified the connection another way — reading a live `sensor` value for battery
is a reasonable substitute, since it proves the same path end to end minus the actuation.

## 3. Ask what the agent may *do* to the car

Each action becomes a member of the `car_control` tool's `action` enum. An action not chosen is
not in the enum, so there is no argument value that reaches it.

Offer what you found in step 1, as a multi-select. Typical candidates:

| Action | Entities | Note when asking |
|---|---|---|
| Air conditioning | `climate.*`, or a climate `switch.*` | The safe one. Already proven in step 2. |
| Door locks | `lock.*` | **Say this out loud when asking:** enabling it means the agent can *unlock* the car, and an unlocked car stays unlocked until someone locks it. Worth taking lock-only, or neither. |
| Charging start/stop | `switch.*` named for charging | Reversible, low stakes. |
| Horn / lights / find-my-car | `button.*` | One-shot, loud, harmless. |
| Windows, boot, frunk | `cover.*` | Ask carefully — these move and can't always be undone remotely. |

For each chosen action, record the entity and the services. Two shapes:

- **Two-state** (AC, locks, charging) — `service` for `on`, `off_service` for `off`. The tool
  requires an explicit `state`, so there is no default direction to get wrong.
- **One-shot** (horn, find-my-car) — `service` only, no `off_service`. The tool then refuses a
  `state` argument rather than quietly ignoring it.

A climate action can also carry a `temperature` block, which adds a `temperature` argument to
`car_control` so "AC on at 20" works from chat. It exists because setting a target is not one
call and not one number:

| Field | Why it's there |
|---|---|
| `min` / `max` | The car's own range, from the climate entity's `min_temp` / `max_temp`. Out-of-range is rejected before any service call. |
| `hvac_mode` | Some integrations **silently discard** `set_temperature` while the entity is `off`. Sending the mode alongside is what makes the write take. |
| `offset` | Degrees the car adds to what you write. Subtracted before sending, so the number the person said is the number the car lands on. |

Establish `offset` empirically rather than assuming `0`: turn the climate on, write a known
value **with** `hvac_mode`, and read the target back. Writing while the entity is `off` proves
nothing — the write is discarded and the value looks unchanged, which is not the same as no
offset. On a BYD ATTO 2 DM-i, writing `22` lands on `24`, so `offset: 2`.

The offset applies to writes only. Readings are left alone: what the car reports is genuinely
where it is set, and correcting that too would turn one discrepancy into two.

Note that `on`/`off` mean what the *action* means, not what the domain calls it: for a lock,
`on` is `lock.lock` and `off` is `lock.unlock`. Set the `label` so the agent — and the user
reading a confirmation message — sees "Doors", not "lock.byd_atto3_door_lock".

## 4. Ask what the agent may *read* from the car

Each reading becomes a field of the `car_status` tool. Readings are all-or-nothing per field:
one not chosen is never fetched and never returned.

Typical candidates, all from step 1:

| Reading | Entity | Note when asking |
|---|---|---|
| Battery level | `sensor.*_battery` / `*_soc` | The most-asked question. |
| Range | `sensor.*_range` | |
| Charging state | `sensor.*_charging` / `binary_sensor.*_charging` | |
| Charge limit / power | `sensor.*` | |
| Odometer | `sensor.*_odometer` | |
| Location | `device_tracker.*` | **Say this out loud when asking:** this is where the car — and usually the person driving it — physically is, and anyone who can message an enabled group can ask for it. Leaving it off is a reasonable default. |
| Doors / windows open | `binary_sensor.*` | |
| Tyre pressure | `sensor.*_tyre_*` | |

A `device_tracker` reading returns the entity state (`home`, `not_home`, a zone name) plus
`latitude` / `longitude` from its attributes, because the state alone rarely answers "where is
it". If the user wants the zone but not the coordinates, don't enable it — there is no
half-setting, and pretending otherwise would be worse than saying so.

For a value that lives in an attribute rather than the state, set `attribute` on the reading.

## 5. Assemble the block

```json
{
  "car": {
    "actions": [
      {
        "name": "ac",
        "label": "Air conditioning",
        "entity_id": "climate.byd_atto3_hvac",
        "service": "climate.turn_on",
        "off_service": "climate.turn_off",
        "temperature": { "min": 15, "max": 31, "offset": 2, "hvac_mode": "heat_cool" }
      },
      {
        "name": "doors",
        "label": "Door locks",
        "entity_id": "lock.byd_atto3_door_lock",
        "service": "lock.lock",
        "off_service": "lock.unlock"
      }
    ],
    "readings": [
      { "name": "battery",  "label": "Battery level",  "entity_id": "sensor.byd_atto3_battery" },
      { "name": "range",    "label": "Estimated range", "entity_id": "sensor.byd_atto3_range" },
      { "name": "charging", "label": "Charging state",  "entity_id": "sensor.byd_atto3_charging_status" }
    ]
  }
}
```

`name` is what the agent passes and what the user will see in logs — keep it short, lowercase,
and obvious. `label` is what gets shown to a person.

Either list may be empty. Actions-only and readings-only are both valid, and the server builds
only the tool that has entries — a read-only car gets `car_status` and no `car_control` at all,
which is a genuinely useful configuration.

## 6. Ask which agent groups get it

```bash
ncl groups list
```

Ask which agent groups should be able to reach the car (`AskUserQuestion` if there are several
candidates). Say plainly while you ask: **anyone who can message an enabled group can use every
action and reading you enabled** — there is no per-person permission layer. For a car that means
unlocking it and locating it, if those are on. This is a narrower answer than for the vacuum;
a group with guests in it is the wrong place for this.

The vacuum's groups and the car's groups do not have to match. `enable.md` merges per group, so
a group can have one, the other, or both.

## Carry forward

The `car` block and the chosen group ids go to `${CLAUDE_SKILL_DIR}/enable.md`.
