# Dreame Cleaner

Needs `HA_URL`, `HA_TOKEN`, `AUTH_MODE`, and the `hac` / `haget` / `hapost` helpers from
`connect.md`. Ends with a `vacuum` block for `services.json` and the list of agent groups that
get it, handed to `enable.md`.

Every call here runs inside a throwaway container on the agent network and carries the token
explicitly. That is the same network path the agent will use, so a failure here is a failure the
agent would have hit. It is *not* the same auth path — a throwaway container has no OneCLI proxy
environment, so `gateway`-mode injection is not exercised until `enable.md` step 4, against a
real agent container.

## 1. Find the vacuum

Don't ask the user to hunt for an entity id in the Home Assistant UI — ask Home Assistant. The
template endpoint returns every `vacuum.*` entity with its friendly name and current state.

```bash
hapost /template '{"template": "{% set ns = namespace(l=[]) %}{% for s in states.vacuum %}{% set ns.l = ns.l + [{\"entity_id\": s.entity_id, \"name\": s.name, \"state\": s.state}] %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}"}'
```

| Result | What to do |
|---|---|
| One entry | That's the vacuum. Show the user the friendly name and entity id and confirm it's the right machine before continuing. |
| Several entries | Show them all and ask which one to drive (`AskUserQuestion`). Include the friendly name — the entity id alone is often unrecognizable. |
| `[]` | Home Assistant exposes no vacuum entities, so there is nothing to find and nothing to guess at. Ask the user for the entity id directly; if they don't have one, the integration isn't set up and they have to add the vacuum in Home Assistant first. Stop here in that case. |
| `401` | The token is wrong or expired. Re-do step 3 of `connect.md`. |

```bash
HA_ENTITY="vacuum.dreame_l10s_ultra"   # <- the entity id the user confirmed
```

Note the `state` you saw. **`unavailable` means the vacuum is offline right now**, and the ping
in step 2 will be accepted by Home Assistant and then do nothing. If it's `unavailable`, say so
and ask the user to wake or reconnect the vacuum before testing, rather than sending a ping you
already know will be silent.

Also look for a cleaning-mode entity while you're here. This is what makes "mop" and "vacuum
only" possible, and it's model-specific — most Dreame integrations expose it as a `select`:

```bash
hapost /template '{"template": "{% set ns = namespace(l=[]) %}{% for s in states.select %}{% if \"mode\" in s.entity_id or \"mop\" in s.entity_id %}{% set ns.l = ns.l + [{\"entity_id\": s.entity_id, \"name\": s.name, \"state\": s.state, \"options\": s.attributes.options}] %}{% endif %}{% endfor %}{{ ns.l | to_json(ensure_ascii=false) }}"}'
```

Look for one whose `options` are cleaning modes — typically `Sweeping`, `Mopping`,
`Sweeping and mopping`. Record it as `HA_MODE_ENTITY` if you find one; leave it unset if you
don't. An empty result is not a failure: plenty of models have no such control, and step 3
simply won't offer mode switching.

## 2. Locate it — after asking

This makes a physical machine emit a sound in someone's home. Ask first, every time, including
on a re-run:

> I'm going to ask the vacuum to announce itself — it'll beep or say something out loud. Ready?

Only once they say yes:

```bash
hapost /services/vacuum/locate "{\"entity_id\": \"$HA_ENTITY\"}"
```

Then ask the user directly: **did you hear it?**

`200` does **not** mean the vacuum made a sound. It means Home Assistant accepted the service
call and dispatched it. The user's ears are the only real confirmation, which is why this step
exists at all.

### When the ping is silent

`200` but nothing heard — work down this list, ordered by how often each is the real cause.

1. **The vacuum is asleep or off its dock.** Many robots ignore or defer commands while
   sleeping. Ask the user to wake it (press a button on the unit) and ping again.
2. **The entity is a different machine.** Common when there's more than one vacuum, or when the
   integration exposes a leftover entity from a removed device. Re-check the live state:

   ```bash
   haget "/states/$HA_ENTITY" | head -c 800; echo
   ```

   `"state": "unavailable"` confirms it — that entity is not a live machine.
3. **The user was out of earshot.** Worth simply asking before debugging further.
4. **The integration doesn't implement `locate`.** Check whether Home Assistant thinks the
   entity supports it:

   ```bash
   hapost /template "{\"template\": \"{{ state_attr('$HA_ENTITY','supported_features') }}\"}"
   ```

   `supported_features` is a bitmask; `locate` is bit `0x200` (512). Check the bit rather than
   eyeballing the number — `echo $(( <value> & 512 ))` prints `512` if locate is supported and
   `0` if it isn't. If it's `0`, the silence is correct behavior, not a misconfiguration. Say
   so, don't offer `locate` in step 3, and verify the entity another way instead: send
   `vacuum.return_to_base` (visible movement) or confirm the live state above.

Non-`200` responses:

| Code | Cause |
|---|---|
| `400` with `not a valid value for dictionary value @ data['entity_id']` | The entity id doesn't exist or isn't a `vacuum.*` entity. Re-run step 1. |
| `401` | Token wrong or expired — redo step 3 of `connect.md`. |
| `404` | Wrong base URL path, or a reverse proxy in front of the wrong backend. |
| `500` | Home Assistant reached the integration and it errored — check HA's own logs (Settings → System → Logs). This is an HA-side problem, not a NanoClaw one. |

Do not continue until the user confirms they heard the ping, or you've established from
`supported_features` that this vacuum can't beep and verified the entity another way. The point
of this step is to fail here, in front of the operator, rather than in a chat message weeks
later.

## 3. Ask which capabilities to enable

Each of these becomes a tool, or an option inside one. A capability not chosen produces no
tool, so the agent has no way to do it and no text about it in its context. Offer them as a
multi-select (`AskUserQuestion`), with a recommended default set marked.

| Capability | What the agent gets | Recommend by default |
|---|---|---|
| `status` | Read state, battery, current mode and suction | **Yes** — read-only, and every other answer gets better with it |
| `list_areas` | Read the list of rooms Home Assistant knows | **Yes** — required by `clean_area` |
| `room_memory` | Remember which room belongs to which person, so "clean my room" works without asking twice | **Yes**, if `clean_area` is on |
| `clean_area` | Clean specific rooms | **Yes** — this is the point of the integration |
| `clean_all` | Clean the whole home | Ask. Long and loud in every room. |
| `stop` | Stop the current job | **Yes** — the one command people need to work when something's wrong |
| `pause` | Pause the current job | Yes |
| `start` | Start or resume | Yes |
| `return_to_base` | Send it back to the dock | Yes |
| `locate` | Make it beep to find it | Yes, if step 2 proved it works |
| `set_mode` | Switch between sweeping / mopping / both | Only if you found `HA_MODE_ENTITY` |
| `set_fan_speed` | Change suction power | Optional |

Two worth flagging while you ask:

- **`room_memory` without `clean_area` is inert** — there's nothing to use a saved room for.
  If they pick one, suggest the other.
- **`clean_all` is the one to think about.** It runs for a long time and is loud in rooms
  belonging to people who didn't ask. The tool tells the agent to get an explicit yes first,
  but that is prose, not a gate (`caveats.md` #5). Leaving it off is a real option.

Assemble the block. Include `mode_entity` only if you found one — the server refuses to build a
`set_mode` tool without something to drive, on purpose:

```json
{
  "vacuum": {
    "entity_id": "vacuum.dreame_l10s_ultra",
    "capabilities": ["status", "list_areas", "room_memory", "clean_area", "stop", "pause", "start", "return_to_base", "locate"],
    "mode_entity": "select.dreame_l10s_ultra_cleaning_mode"
  }
}
```

## 4. Ask which agent groups get it

```bash
ncl groups list
```

Ask which agent groups should be able to drive the vacuum (`AskUserQuestion` if there are
several candidates). Worth saying while you ask: **anyone who can message an enabled group can
start the vacuum**, because there is no per-person permission layer — the enabled group's whole
audience gets the capability. In a household group that's fine; in a channel with guests in it,
it isn't.

## Carry forward

The `vacuum` block and the chosen group ids go to `${CLAUDE_SKILL_DIR}/enable.md`, which merges
them into whatever those groups already have rather than replacing it.
