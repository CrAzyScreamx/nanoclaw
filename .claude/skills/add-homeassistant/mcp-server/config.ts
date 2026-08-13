/**
 * Per-group Home Assistant config for the `ha-mcp` stdio MCP server.
 *
 * Two files, each with one owner, both under `/workspace/agent/home-assistant/`:
 *
 *   config.env   — the connection. URL, auth mode, and (in `token` mode only)
 *                  the long-lived access token. Mode 0600. This is the file
 *                  REMOVE.md wipes as a credential removal.
 *   services.json — which services are wired and which capabilities of each
 *                  are enabled. No secrets. Written by `/add-homeassistant`.
 *
 * The split is deliberate: a reader looking for "where is the token" has one
 * answer, and re-running the skill to add a capability never rewrites the
 * credential file.
 *
 * Neither file is read by the agent — the server is the only consumer. It is
 * still on a mount the agent can read; see the skill's caveats.md #2.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = process.env.HA_CONFIG_DIR || '/workspace/agent/home-assistant';

export interface Connection {
  url: string;
  auth: 'gateway' | 'token';
  token?: string;
}

/** A vacuum capability the operator turned on. One tool, or one enum member, each. */
export type VacuumCapability =
  | 'status'
  | 'list_areas'
  | 'room_memory'
  | 'clean_area'
  | 'clean_all'
  | 'start'
  | 'pause'
  | 'stop'
  | 'return_to_base'
  | 'locate'
  | 'set_mode'
  | 'set_fan_speed';

export interface VacuumService {
  entity_id: string;
  capabilities: VacuumCapability[];
  /** `select.*` entity holding the cleaning mode (sweep / mop / both), if this model has one. */
  mode_entity?: string;
  /**
   * Room cleaning is an *integration* service, not core Home Assistant, and its
   * shape varies by integration and version. Overridable here so a break can be
   * fixed by editing services.json rather than this file. See caveats.md #3.
   */
  clean_area_service?: string;
  clean_area_param?: string;
}

/**
 * A settable target temperature on a climate action.
 *
 * `offset` exists because some vehicles do not store what you send: the BYD
 * ATTO 2 lands 2°C above the written value, so writing 18 yields 20. The
 * server subtracts `offset` on the way in, which makes the number the user
 * says the number the car ends up on. It is *not* applied to readings — what
 * the car reports is genuinely where it is set, and correcting that too would
 * turn one honest discrepancy into two lies.
 *
 * `hvac_mode` is sent alongside `set_temperature` because the write is
 * otherwise silently discarded while the climate entity is `off`.
 */
export interface CarTemperature {
  min: number;
  max: number;
  /** Degrees the car adds to whatever is written. Subtracted before sending. */
  offset?: number;
  /** hvac_mode to send with set_temperature so the write takes effect. */
  hvac_mode?: string;
  /** Defaults to `climate.set_temperature`. */
  service?: string;
}

/**
 * One controllable thing. `service` runs for state `on`; `off_service` for
 * state `off`. An action with no `off_service` is one-shot (a button, a horn)
 * and its tool takes no `state`.
 *
 * Shared by the car and the printer because the shape is genuinely the same —
 * an entity and one or two services. What differs between them is which tool
 * carries the action, not how an action is described.
 */
export interface DeviceAction {
  name: string;
  label: string;
  entity_id: string;
  service: string;
  off_service?: string;
}

/** One readable value: an entity, and optionally which attribute of it to read. */
export interface DeviceReading {
  name: string;
  label: string;
  entity_id: string;
  /** Read this attribute instead of the entity state (e.g. `latitude` on a device_tracker). */
  attribute?: string;
}

export interface CarAction extends DeviceAction {
  /** Present only on climate actions that accept a target temperature. */
  temperature?: CarTemperature;
}

export type CarReading = DeviceReading;

export interface CarService {
  actions: CarAction[];
  readings: CarReading[];
}

/**
 * What a printer reading is *about*. Used for grouping the status report and
 * for the `kind` filter, so "how much ink is left" doesn't come back with a
 * page counter attached.
 *
 * An absent or unrecognized kind reports under `other` rather than being
 * dropped — a reading the operator enabled should never be silently invisible.
 */
export type PrinterReadingKind = 'status' | 'supply' | 'tray' | 'counter' | 'connectivity' | 'other';

export interface PrinterReading extends DeviceReading {
  kind?: PrinterReadingKind;
  /**
   * Percentage at or below which this supply counts as low.
   *
   * Optional on purpose: IPP printers publish their own `marker_low_level`
   * (15% on a Canon TS3100) and the server falls back to it, so a discovered
   * printer usually needs nothing here. Set it only to overrule what the
   * printer says — and expect no `low` flag at all on an integration that
   * publishes neither.
   */
  low_threshold?: number;
}

export type PrinterAction = DeviceAction;

/**
 * One printer. A list, unlike the vacuum and the car, because two printers in
 * one house is ordinary — and because the tools hide the distinction when
 * there is only one, the single-printer case costs nothing for it.
 */
export interface PrinterService {
  /** Short id the agent passes to pick this printer. Unique within the list. */
  name: string;
  label: string;
  readings: PrinterReading[];
  actions?: PrinterAction[];
}

export interface Services {
  vacuum?: VacuumService;
  car?: CarService;
  printers?: PrinterService[];
}

export class ConfigError extends Error {}

/**
 * Minimal `KEY=VALUE` reader. Not a general dotenv: no interpolation, no
 * `export`, no multi-line values — the file is written by this skill and
 * nothing else, so the grammar is exactly what the skill emits.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function connectionFrom(env: Record<string, string>): Connection {
  const url = (env.HA_URL || '').replace(/\/+$/, '');
  if (!url) throw new ConfigError('HA_URL is missing from config.env');

  const auth = env.HA_AUTH === 'token' ? 'token' : 'gateway';
  if (auth === 'token' && !env.HA_TOKEN) {
    throw new ConfigError('HA_AUTH=token but HA_TOKEN is missing from config.env');
  }
  return auth === 'token' ? { url, auth, token: env.HA_TOKEN } : { url, auth };
}

export function loadConnection(dir: string = CONFIG_DIR): Connection {
  const file = path.join(dir, 'config.env');
  if (!fs.existsSync(file)) {
    throw new ConfigError(`No Home Assistant config at ${file} — this agent group is not enabled`);
  }
  return connectionFrom(parseEnvFile(fs.readFileSync(file, 'utf8')));
}

/**
 * Absent or empty services.json means "enabled but nothing wired" — the server
 * starts with zero tools rather than failing. That is the state between the
 * connect phase and the first service phase, and it should not crash a
 * container.
 */
export function loadServices(dir: string = CONFIG_DIR): Services {
  const file = path.join(dir, 'services.json');
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`services.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('services.json must be a JSON object');
  }
  return parsed as Services;
}
