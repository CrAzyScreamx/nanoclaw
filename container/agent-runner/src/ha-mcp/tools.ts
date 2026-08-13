/**
 * Tool construction. This file is where "only what the operator enabled"
 * actually happens: every tool below is built from services.json and a
 * capability that was never enabled produces no tool at all, so it is absent
 * from `tools/list` rather than present-and-refusing.
 *
 * That is the useful property. An agent cannot be talked into a capability it
 * has no tool for, and it does not spend context reading about one.
 *
 * It is not a security boundary — see the skill's caveats.md #1 for what this
 * does and does not stop.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type {
  CarAction,
  CarService,
  DeviceAction,
  DeviceReading,
  PrinterReading,
  PrinterReadingKind,
  PrinterService,
  Services,
  VacuumCapability,
  VacuumService,
} from './config.js';
import { HaError, HomeAssistant, listAreas } from './ha.js';
import { getRoom, setRoom } from './rooms.js';

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function json(value: unknown): CallToolResult {
  return ok(JSON.stringify(value, null, 2));
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/**
 * One place where a thrown HaError becomes a tool error. Anything else is a bug
 * in this server and is reported as such rather than dressed up as a Home
 * Assistant problem — the two need different fixes.
 */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HaError) return fail(e.message);
    return fail(`ha-mcp internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

const DISPATCHED =
  'Home Assistant accepted the command. That means it was dispatched, not that the device has finished or even started — read the status if you need to know what actually happened.';

/**
 * Check `state` against an action's shape and pick the service to call. A
 * two-state action demands an explicit state, so there is no default direction
 * to get wrong; a one-shot one refuses a state rather than ignoring it.
 */
function pickActionService(action: DeviceAction, state: string | undefined): { service: string } | { error: string } {
  if (action.off_service) {
    if (state !== 'on' && state !== 'off') {
      return { error: `"${action.name}" (${action.label}) needs state "on" or "off"` };
    }
    return { service: state === 'off' ? action.off_service : action.service };
  }
  if (state) return { error: `"${action.name}" (${action.label}) is one-shot and takes no state` };
  return { service: action.service };
}

/**
 * Read one entity for a status report. Deliberately never throws: one dead
 * entity should not blank a whole report, because the other readings are still
 * true and still useful.
 */
async function fetchReading(
  ha: HomeAssistant,
  entityId: string,
): Promise<{ state: string; attrs: Record<string, unknown> } | { error: string }> {
  try {
    const s = await ha.getState(entityId);
    return { state: String(s.state), attrs: (s.attributes ?? {}) as Record<string, unknown> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The value a reading reports: an attribute if it names one, otherwise the entity state. */
function readingValue(reading: DeviceReading, state: string, attrs: Record<string, unknown>): unknown {
  return reading.attribute ? (attrs[reading.attribute] ?? null) : state;
}

// ---------------------------------------------------------------------------
// Vacuum
// ---------------------------------------------------------------------------

/** Enum members of `vacuum_control`, in the order they are offered to the agent. */
const CONTROL_CAPS: { cap: VacuumCapability; service: string; blurb: string }[] = [
  { cap: 'start', service: 'vacuum.start', blurb: 'start or resume cleaning' },
  { cap: 'pause', service: 'vacuum.pause', blurb: 'pause the current job' },
  { cap: 'stop', service: 'vacuum.stop', blurb: 'stop the current job' },
  { cap: 'return_to_base', service: 'vacuum.return_to_base', blurb: 'send it back to its dock' },
  { cap: 'locate', service: 'vacuum.locate', blurb: 'make it beep so someone can find it' },
];

function vacuumTools(vac: VacuumService, ha: HomeAssistant, configDir: string): ToolDefinition[] {
  const has = (c: VacuumCapability) => vac.capabilities.includes(c);
  const tools: ToolDefinition[] = [];
  const entity = vac.entity_id;

  if (has('status')) {
    tools.push({
      tool: {
        name: 'vacuum_status',
        description:
          'Read the vacuum: state (docked / cleaning / paused / returning / idle / error / unavailable), battery level, and — where the model exposes them — the current cleaning mode and fan speed with their available options. `unavailable` means the machine is offline and commands will be accepted but do nothing.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () =>
        guard(async () => {
          const state = await ha.getState(entity);
          const attrs = (state.attributes ?? {}) as Record<string, unknown>;
          const out: Record<string, unknown> = {
            entity_id: entity,
            state: state.state,
            battery_level: attrs.battery_level ?? null,
            fan_speed: attrs.fan_speed ?? null,
            fan_speed_list: attrs.fan_speed_list ?? null,
          };
          if (vac.mode_entity) {
            const mode = await ha.getState(vac.mode_entity);
            const modeAttrs = (mode.attributes ?? {}) as Record<string, unknown>;
            out.cleaning_mode = mode.state;
            out.cleaning_mode_options = modeAttrs.options ?? null;
          }
          return json(out);
        }),
    });
  }

  if (has('list_areas')) {
    tools.push({
      tool: {
        name: 'vacuum_list_areas',
        description:
          'List the areas (rooms) Home Assistant knows about, as `{area_id, name}`. Show people the names — the ids are generated and mean nothing to them. Every other tool that takes an area takes the `area_id` from this list; there is no way to construct one from a name.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => guard(async () => json(await listAreas(ha))),
    });
  }

  if (has('room_memory')) {
    tools.push({
      tool: {
        name: 'vacuum_get_room',
        description:
          'Look up which area a person calls their room. Pass the `sender` attribute of the incoming message exactly as it appears — do not strip a suffix, substitute a display name, or tidy it up, or the lookup misses and you will ask someone a question they already answered. Returns `{found: false}` when they have never said.',
        inputSchema: {
          type: 'object',
          properties: { sender: { type: 'string', description: 'The sender attribute of the incoming message, verbatim' } },
          required: ['sender'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const sender = str(args, 'sender');
          if (!sender) return fail('sender is required');
          const room = getRoom(configDir, sender);
          return json(room ? { found: true, ...room } : { found: false });
        }),
    });

    tools.push({
      tool: {
        name: 'vacuum_remember_room',
        description:
          'Record which area a person calls their room, so nobody is asked twice. Use the same verbatim `sender` as `vacuum_get_room`, and an `area_id` that came back from `vacuum_list_areas`. Save it as soon as they answer — before starting a clean, so a failed clean does not lose the answer. Re-saving replaces their previous room rather than adding a second.',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'The sender attribute of the incoming message, verbatim' },
            area_id: { type: 'string', description: 'An area_id from vacuum_list_areas' },
          },
          required: ['sender', 'area_id'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const sender = str(args, 'sender');
          const areaId = str(args, 'area_id');
          if (!sender) return fail('sender is required');
          if (!areaId) return fail('area_id is required');

          // Resolve the name here rather than trusting a passed-in one: the map
          // is displayed back to people later, and an area renamed in Home
          // Assistant should not leave a stale label in it.
          const areas = await listAreas(ha);
          const match = areas.find((a) => a.area_id === areaId);
          if (!match) {
            return fail(`No area "${areaId}" in Home Assistant. Known areas: ${areas.map((a) => `${a.area_id} (${a.name})`).join(', ')}`);
          }
          setRoom(configDir, { sender, area_id: match.area_id, area_name: match.name });
          return ok(`Saved: ${sender} → ${match.name} (${match.area_id})`);
        }),
    });
  }

  if (has('clean_area')) {
    const service = vac.clean_area_service ?? 'vacuum.clean_area';
    const param = vac.clean_area_param ?? 'cleaning_area_id';
    tools.push({
      tool: {
        name: 'vacuum_clean_area',
        description:
          'Send the vacuum to clean specific areas. Takes `area_id` values from `vacuum_list_areas` — never a name, and never an id you constructed yourself. This starts a real machine in someone\'s home: one call per request, and do not re-issue it because the reply was slow.',
        inputSchema: {
          type: 'object',
          properties: {
            area_ids: { type: 'array', items: { type: 'string' }, description: 'One or more area_id values from vacuum_list_areas' },
          },
          required: ['area_ids'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const areaIds = strArray(args, 'area_ids');
          if (areaIds.length === 0) return fail('area_ids must contain at least one area_id');
          const areas = await listAreas(ha);
          const known = new Set(areas.map((a) => a.area_id));
          const unknown = areaIds.filter((a) => !known.has(a));
          if (unknown.length > 0) {
            return fail(`Unknown area_id(s): ${unknown.join(', ')}. Known areas: ${areas.map((a) => `${a.area_id} (${a.name})`).join(', ')}`);
          }
          await ha.callService(service, { entity_id: entity, [param]: areaIds });
          const names = areaIds.map((id) => areas.find((a) => a.area_id === id)?.name ?? id);
          return ok(`Cleaning started for: ${names.join(', ')}. ${DISPATCHED}`);
        }),
    });
  }

  if (has('clean_all')) {
    tools.push({
      tool: {
        name: 'vacuum_clean_everywhere',
        description:
          'Clean the whole home. This runs for a long time and is loud in every room, including rooms belonging to people who did not ask — get an explicit yes before calling it, and say how many areas it covers. A request naming one room is not a request for this.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () =>
        guard(async () => {
          await ha.callService('vacuum.start', { entity_id: entity });
          return ok(`Whole-home clean started. ${DISPATCHED}`);
        }),
    });
  }

  const controls = CONTROL_CAPS.filter((c) => has(c.cap));
  if (controls.length > 0) {
    tools.push({
      tool: {
        name: 'vacuum_control',
        description:
          `Send a direct command to the vacuum. Available here: ${controls.map((c) => `\`${c.cap}\` — ${c.blurb}`).join('; ')}. ` +
          'Treat `stop` as urgent: it is what people say when something is wrong, so run it immediately and confirm afterwards rather than asking a clarifying question first.',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string', enum: controls.map((c) => c.cap), description: 'The command to send' } },
          required: ['command'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const command = str(args, 'command');
          const match = controls.find((c) => c.cap === command);
          if (!match) return fail(`Unknown command "${command ?? ''}". Available: ${controls.map((c) => c.cap).join(', ')}`);
          await ha.callService(match.service, { entity_id: entity });
          if (match.cap === 'locate') {
            // The honest phrasing matters: Home Assistant reports the vacuum's
            // state, never its position, so "it is in the hallway" would be invented.
            return ok('The vacuum is beeping now — follow the sound. Home Assistant does not report where it is, only that the command was sent.');
          }
          return ok(`Sent \`${match.cap}\`. ${DISPATCHED}`);
        }),
    });
  }

  if (has('set_mode') && vac.mode_entity) {
    const modeEntity = vac.mode_entity;
    tools.push({
      tool: {
        name: 'vacuum_set_mode',
        description:
          'Set the cleaning mode — sweeping, mopping, or both, depending on what this model offers. Read `cleaning_mode_options` from `vacuum_status` first; the accepted values come from Home Assistant and vary by model. This only changes the mode; it does not start a job.',
        inputSchema: {
          type: 'object',
          properties: { mode: { type: 'string', description: 'One of cleaning_mode_options from vacuum_status' } },
          required: ['mode'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const mode = str(args, 'mode');
          if (!mode) return fail('mode is required');
          const state = await ha.getState(modeEntity);
          const options = ((state.attributes ?? {}) as Record<string, unknown>).options;
          if (Array.isArray(options) && !options.includes(mode)) {
            return fail(`"${mode}" is not an option for this vacuum. Available: ${options.join(', ')}`);
          }
          await ha.callService('select.select_option', { entity_id: modeEntity, option: mode });
          return ok(`Cleaning mode set to ${mode}.`);
        }),
    });
  }

  if (has('set_fan_speed')) {
    tools.push({
      tool: {
        name: 'vacuum_set_fan_speed',
        description:
          'Set suction power. Read `fan_speed_list` from `vacuum_status` for the accepted values — they are model-specific strings, not numbers. This only changes the setting; it does not start a job.',
        inputSchema: {
          type: 'object',
          properties: { fan_speed: { type: 'string', description: 'One of fan_speed_list from vacuum_status' } },
          required: ['fan_speed'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const speed = str(args, 'fan_speed');
          if (!speed) return fail('fan_speed is required');
          const state = await ha.getState(entity);
          const list = ((state.attributes ?? {}) as Record<string, unknown>).fan_speed_list;
          if (Array.isArray(list) && !list.includes(speed)) {
            return fail(`"${speed}" is not a fan speed for this vacuum. Available: ${list.join(', ')}`);
          }
          await ha.callService('vacuum.set_fan_speed', { entity_id: entity, fan_speed: speed });
          return ok(`Fan speed set to ${speed}.`);
        }),
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

function describeAction(a: CarAction): string {
  const base = a.off_service
    ? `\`${a.name}\` — ${a.label} (takes \`state\`)`
    : `\`${a.name}\` — ${a.label} (one-shot, no \`state\`)`;
  return a.temperature ? `${base} (accepts \`temperature\`, ${a.temperature.min}–${a.temperature.max}°C)` : base;
}

/** Actions on this car that take a target temperature, for the tool schema. */
function temperatureActions(car: CarService): CarAction[] {
  return car.actions.filter((a) => a.temperature);
}

function carTools(car: CarService, ha: HomeAssistant): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (car.actions.length > 0) {
    tools.push({
      tool: {
        name: 'car_control',
        description:
          `Operate the car. Enabled here: ${car.actions.map(describeAction).join('; ')}. ` +
          'The car may be parked somewhere public and someone may be in it — say what you are about to do and get a yes before the first call in a conversation. Unlocking in particular leaves the car unlocked until someone locks it again.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: car.actions.map((a) => a.name), description: 'Which control to operate' },
            state: { type: 'string', enum: ['on', 'off'], description: 'Required for two-state controls; omit for one-shot ones' },
            ...(temperatureActions(car).length > 0
              ? {
                  temperature: {
                    type: 'number',
                    description:
                      `Target temperature in °C, for actions that accept one (${temperatureActions(car)
                        .map((a) => `${a.name}: ${a.temperature!.min}–${a.temperature!.max}`)
                        .join('; ')}). ` +
                      'Pass the temperature the person actually asked for — any correction this car needs is applied for you. Only valid with state "on".',
                  },
                }
              : {}),
          },
          required: ['action'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const name = str(args, 'action');
          const action = car.actions.find((a) => a.name === name);
          if (!action) return fail(`Unknown action "${name ?? ''}". Available: ${car.actions.map((a) => a.name).join(', ')}`);

          const state = str(args, 'state');
          const picked = pickActionService(action, state);
          if ('error' in picked) return fail(picked.error);

          const wanted = args.temperature;
          if (wanted !== undefined && wanted !== null) {
            if (!action.temperature) {
              return fail(`"${action.name}" (${action.label}) does not take a temperature`);
            }
            if (typeof wanted !== 'number' || !Number.isFinite(wanted)) {
              return fail('temperature must be a number in °C');
            }
            if (state === 'off') {
              return fail('temperature cannot be set while turning the control off');
            }
            const { min, max } = action.temperature;
            if (wanted < min || wanted > max) {
              return fail(`${wanted}°C is outside this car's range (${min}–${max}°C)`);
            }
          }

          await ha.callService(picked.service, { entity_id: action.entity_id });

          // Second call: the target temperature is a separate service, and it is
          // discarded unless the climate entity is on — hence after the turn-on.
          if (wanted !== undefined && wanted !== null && action.temperature) {
            const t = action.temperature;
            await ha.callService(t.service ?? 'climate.set_temperature', {
              entity_id: action.entity_id,
              temperature: (wanted as number) - (t.offset ?? 0),
              ...(t.hvac_mode ? { hvac_mode: t.hvac_mode } : {}),
            });
            return ok(`${action.label}${state ? ` → ${state}` : ''} at ${wanted}°C. ${DISPATCHED}`);
          }

          return ok(`${action.label}${state ? ` → ${state}` : ''}. ${DISPATCHED}`);
        }),
    });
  }

  if (car.readings.length > 0) {
    tools.push({
      tool: {
        name: 'car_status',
        description:
          `Read the car. Available here: ${car.readings.map((r) => `\`${r.name}\` — ${r.label}`).join('; ')}. ` +
          'Returns every reading by default; pass `readings` to narrow it. A reading of `unavailable` or `unknown` means the car has not reported recently — report that as-is rather than as a number.',
        inputSchema: {
          type: 'object',
          properties: {
            readings: {
              type: 'array',
              items: { type: 'string', enum: car.readings.map((r) => r.name) },
              description: 'Subset of readings to return. Omit for all of them.',
            },
          },
        },
      },
      handler: (args) =>
        guard(async () => {
          const want = strArray(args, 'readings');
          const unknown = want.filter((w) => !car.readings.some((r) => r.name === w));
          if (unknown.length > 0) {
            return fail(`Unknown reading(s): ${unknown.join(', ')}. Available: ${car.readings.map((r) => r.name).join(', ')}`);
          }
          const selected = want.length > 0 ? car.readings.filter((r) => want.includes(r.name)) : car.readings;

          const out: Record<string, unknown> = {};
          for (const reading of selected) {
            const got = await fetchReading(ha, reading.entity_id);
            if ('error' in got) {
              out[reading.name] = { label: reading.label, error: got.error };
              continue;
            }
            const { state, attrs } = got;
            out[reading.name] = {
              label: reading.label,
              value: readingValue(reading, state, attrs),
              unit: attrs.unit_of_measurement ?? null,
              // A device_tracker carries coordinates as attributes; surfacing
              // them lets the agent answer "where is it" with something real.
              ...(attrs.latitude !== undefined ? { latitude: attrs.latitude, longitude: attrs.longitude } : {}),
            };
          }
          return json(out);
        }),
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

/** Report order: what someone actually wants first, not alphabetical. */
const KIND_ORDER: PrinterReadingKind[] = ['status', 'supply', 'tray', 'counter', 'connectivity', 'other'];

function kindOf(r: PrinterReading): PrinterReadingKind {
  return r.kind && KIND_ORDER.includes(r.kind) ? r.kind : 'other';
}

/**
 * Supply levels are percentages, but RFC 8011 also allows negative sentinels
 * for "this printer does not report a level", and HA's IPP integration passes
 * them through verbatim. Reporting `-1%` of ink would be worse than reporting
 * nothing, so anything that isn't a real percentage comes back as null and the
 * raw string is kept alongside it.
 */
function supplyLevel(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * What counts as low, in preference order: the operator's override, then the
 * printer's own opinion (`marker_low_level`, which IPP publishes — 15% on a
 * Canon TS3100). Neither means no `low` flag at all rather than a guessed
 * threshold, because "low" is a claim and inventing the line makes it a false one.
 */
function lowThreshold(reading: PrinterReading, attrs: Record<string, unknown>): number | undefined {
  if (typeof reading.low_threshold === 'number') return reading.low_threshold;
  const own = attrs.marker_low_level;
  return typeof own === 'number' && own >= 0 ? own : undefined;
}

/**
 * Attributes worth lifting onto a status reading. `state_reason` is the one
 * that matters: it turns "the printer is stopped" into "the printer is out of
 * paper", which is the difference between a useful answer and a useless one.
 */
const STATUS_EXTRAS: { attr: string; as: string }[] = [
  { attr: 'state_message', as: 'message' },
  { attr: 'state_reason', as: 'reason' },
  { attr: 'info', as: 'printer_name' },
  { attr: 'location', as: 'location' },
];

function shapeReading(reading: PrinterReading, state: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const kind = kindOf(reading);
  const value = readingValue(reading, state, attrs);
  const out: Record<string, unknown> = { label: reading.label, value, unit: attrs.unit_of_measurement ?? null };

  if (kind === 'supply' && typeof value === 'string') {
    const level = supplyLevel(value);
    if (level === null) {
      // Not a failure and not zero ink: this printer simply doesn't say.
      out.value = null;
      out.reported = value;
      out.note = 'This printer does not report a level for this supply.';
    } else {
      out.value = level;
      const threshold = lowThreshold(reading, attrs);
      if (threshold !== undefined) {
        out.low = level <= threshold;
        out.low_at = threshold;
      }
      if (typeof attrs.marker_type === 'string') out.type = attrs.marker_type;
    }
  }

  if (kind === 'status') {
    for (const { attr, as } of STATUS_EXTRAS) {
      const v = attrs[attr];
      if (v !== undefined && v !== null && v !== '') out[as] = v;
    }
  }

  return out;
}

function printerTools(printers: PrinterService[], ha: HomeAssistant): ToolDefinition[] {
  const readable = printers.filter((p) => Array.isArray(p.readings) && p.readings.length > 0);
  const operable = printers.filter((p) => Array.isArray(p.actions) && p.actions.length > 0);
  const tools: ToolDefinition[] = [];

  if (readable.length > 0) {
    const kinds = KIND_ORDER.filter((k) => readable.some((p) => p.readings.some((r) => kindOf(r) === k)));
    const many = readable.length > 1;

    tools.push({
      tool: {
        name: 'printer_status',
        description:
          `Read the printer${many ? 's' : ''}: ${readable.map((p) => `\`${p.name}\` — ${p.label}`).join('; ')}. ` +
          `Covers ${kinds.join(', ')} readings. This is the tool for "how much ink is left", "is the printer online", and "why won't it print" — ` +
          'a supply comes back with a `low` flag against the printer\'s own threshold, and a stopped printer comes back with the `reason` it stopped. ' +
          'A reading of `unavailable` almost always means the printer is asleep rather than broken; say that, and say it usually wakes when a job arrives. ' +
          'This cannot print anything and cannot see the job queue — it reports what Home Assistant knows about the hardware.',
        inputSchema: {
          type: 'object',
          properties: {
            ...(many
              ? { printer: { type: 'string', enum: readable.map((p) => p.name), description: 'Which printer. Omit for all of them.' } }
              : {}),
            kind: {
              type: 'string',
              enum: kinds,
              description: 'Narrow to one kind of reading — `supply` for ink or toner levels. Omit for everything.',
            },
          },
        },
      },
      handler: (args) =>
        guard(async () => {
          const which = str(args, 'printer');
          if (which && !readable.some((p) => p.name === which)) {
            return fail(`Unknown printer "${which}". Available: ${readable.map((p) => p.name).join(', ')}`);
          }
          const kind = str(args, 'kind');
          if (kind && !kinds.includes(kind as PrinterReadingKind)) {
            return fail(`Unknown kind "${kind}". Available: ${kinds.join(', ')}`);
          }

          const selected = which ? readable.filter((p) => p.name === which) : readable;
          const out: Record<string, unknown> = {};

          for (const printer of selected) {
            const entry: Record<string, unknown> = { label: printer.label };
            const wanted = kind ? printer.readings.filter((r) => kindOf(r) === kind) : printer.readings;

            for (const reading of wanted) {
              const group = (entry[kindOf(reading)] ??= {}) as Record<string, unknown>;
              const got = await fetchReading(ha, reading.entity_id);
              group[reading.name] =
                'error' in got ? { label: reading.label, error: got.error } : shapeReading(reading, got.state, got.attrs);
            }
            out[printer.name] = entry;
          }
          return json(out);
        }),
    });
  }

  if (operable.length > 0) {
    const many = operable.length > 1;
    const described = operable
      .map((p) => {
        const acts = (p.actions ?? [])
          .map((a) => (a.off_service ? `\`${a.name}\` — ${a.label} (takes \`state\`)` : `\`${a.name}\` — ${a.label} (one-shot, no \`state\`)`))
          .join(', ');
        return many ? `${p.label} (\`${p.name}\`): ${acts}` : acts;
      })
      .join('; ');

    tools.push({
      tool: {
        name: 'printer_control',
        description:
          `Operate the printer${many ? 's' : ''}. Enabled here: ${described}. ` +
          'This does not print anything — it drives whatever the operator wired up, typically power via a smart plug. ' +
          'Turning a printer off mid-job loses the job, so read the status first if anything might be printing.',
        inputSchema: {
          type: 'object',
          properties: {
            ...(many
              ? { printer: { type: 'string', enum: operable.map((p) => p.name), description: 'Which printer to operate' } }
              : {}),
            action: {
              type: 'string',
              enum: [...new Set(operable.flatMap((p) => (p.actions ?? []).map((a) => a.name)))],
              description: 'Which control to operate',
            },
            state: { type: 'string', enum: ['on', 'off'], description: 'Required for two-state controls; omit for one-shot ones' },
          },
          required: many ? ['printer', 'action'] : ['action'],
        },
      },
      handler: (args) =>
        guard(async () => {
          const which = str(args, 'printer');
          // With one printer the argument doesn't exist, so don't demand it;
          // with several there is no sensible default and guessing would
          // power-cycle the wrong machine.
          const printer = many ? operable.find((p) => p.name === which) : operable[0];
          if (!printer) {
            return fail(`Unknown printer "${which ?? ''}". Available: ${operable.map((p) => p.name).join(', ')}`);
          }

          const actions = printer.actions ?? [];
          const name = str(args, 'action');
          const action = actions.find((a) => a.name === name);
          if (!action) {
            return fail(`Unknown action "${name ?? ''}" for ${printer.label}. Available: ${actions.map((a) => a.name).join(', ')}`);
          }

          const state = str(args, 'state');
          const picked = pickActionService(action, state);
          if ('error' in picked) return fail(picked.error);

          await ha.callService(picked.service, { entity_id: action.entity_id });
          return ok(`${printer.label}: ${action.label}${state ? ` → ${state}` : ''}. ${DISPATCHED}`);
        }),
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------

export function buildTools(services: Services, ha: HomeAssistant, configDir: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (services.vacuum) tools.push(...vacuumTools(services.vacuum, ha, configDir));
  if (services.car) tools.push(...carTools(services.car, ha));
  if (Array.isArray(services.printers)) tools.push(...printerTools(services.printers, ha));
  return tools;
}
