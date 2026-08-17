// ============================================================================
// lib/state.ts — the read-write workspace.
//
// The plugin directory is mounted READ-ONLY and is never written to. Everything
// this template remembers lives under /workspace/agent/voice-line/:
//
//   config.json          provider, lines and their carriers, carrier identifiers
//   state.json           sweep watermarks, last-run timestamps, sweep dedup memory
//   calls.jsonl          append-only call log, trimmed to the newest 2000 lines
//   campaigns/<id>.json  one record per submitted campaign
//
// NO TOKEN, KEY, PASSWORD OR BASIC VALUE IS EVER PERSISTED HERE. Credentials
// live in the OneCLI vault and are injected by the gateway on the way out; an
// Account SID or a regional subdomain is an identifier, not a secret, so those
// are the only carrier facts written down. writeConfig() enforces this.
//
// Every reader returns documented defaults when a file is missing, so a fresh
// container never crashes on first use. Every writer creates the directory and
// writes atomically (temp file + rename).
// ============================================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { CallDirection, CarrierValue, Line } from './provider.ts';
import { ExitCode, VoiceToolError } from './provider.ts';

/**
 * VOICE_LINE_HOME is a TEST HOOK ONLY — it lets these tools be exercised
 * outside a container. It is a directory path, never a credential.
 */
export const STATE_DIR: string = process.env.VOICE_LINE_HOME ?? '/workspace/agent/voice-line';
export const CONFIG_PATH = `${STATE_DIR}/config.json`;
export const STATE_PATH = `${STATE_DIR}/state.json`;
export const CALL_LOG_PATH = `${STATE_DIR}/calls.jsonl`;
export const CAMPAIGN_DIR = `${STATE_DIR}/campaigns`;

const CALL_LOG_MAX_LINES = 2000;

export interface LineConfig {
  number: string;
  label: string;
  /** As reported by the provider; may be outside CarrierKind. See CarrierValue. */
  carrier: CarrierValue;
  personaId: string | null;
}

/**
 * config.json — identifiers only. An Account SID is an identifier, not a secret.
 *
 * Only `twilio` appears: it is the one carrier with a hang-up adapter here. A
 * config written by an older build may still carry `exotel` / `sip` blocks; they
 * are read back untouched by readConfig's spread and simply go unused, so an
 * existing workspace does not need cleaning up.
 */
export interface VoiceLineConfig {
  provider: string;                        // 'elevenlabs'
  lines: Record<string, LineConfig>;       // keyed by line id
  twilio?: { accountSid: string };
  updatedAt: number;
}

/**
 * What the sweep remembers between fires, per direction.
 *
 * This is a CORRECTNESS structure, not bookkeeping: the sweep holds its
 * watermark back behind any call still running, so the same finished call is
 * legitimately re-fetched fire after fire, and `reported` is the only thing
 * standing between that and the same call waking the agent twice. It lives here
 * rather than in calls.jsonl (which is an audit log, trimmed by line count)
 * precisely so a busy line cannot trim the dedup memory away.
 */
export interface SweepMemory {
  /** call id → its start time, for calls already delivered. null = the row carried no start time. */
  reported: Record<string, number | null>;
  /** call id → when a still-running call with no usable start time was first seen; the only clock it has. */
  firstSeen: Record<string, number>;
  /** call id → when the sweep stopped waiting for it and said so in a payload. Reported once. */
  abandoned: Record<string, number>;
}

/** state.json — sweep watermarks, unix seconds, and the sweep's memory. */
export interface VoiceLineState {
  watermarks: { inbound: number; outbound: number };
  lastSweep: { inbound: number; outbound: number };
  sweep: { inbound: SweepMemory; outbound: SweepMemory };
}

/**
 * Per map, per direction. Entries survive pruning only while they are still
 * re-fetchable, so evicting one risks a duplicate report — the cap is a
 * last-resort bound on state.json, and the sweep says so out loud when it bites.
 */
const SWEEP_MEMORY_MAX = 2000;

// ------------------------------------------------------------------ plumbing

/** Unix seconds. Exported so callers stamp time the same way this file does. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw new VoiceToolError(
      `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'state_write_failed', exitCode: ExitCode.UNEXPECTED },
    );
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt state file must never take a tool down; defaults win.
    return fallback;
  }
}

// -------------------------------------------------------------- credentials

const CREDENTIAL_KEY = /(token|secret|password|api_?key|auth|credential|private_?key)/i;

function refuseCredential(path: string, key: string): never {
  throw new VoiceToolError(
    `Refusing to write "${path}.${key}" to ${CONFIG_PATH}: that looks like a credential. ` +
      'Credentials belong in the OneCLI vault, where the gateway injects them by destination host — ' +
      'nothing in this container ever stores one.',
    { code: 'credential_in_config', exitCode: ExitCode.USAGE, hint: 'skills/voice-line/references/connect-provider.md' },
  );
}

/**
 * Rejects credential-shaped keys anywhere in the patch. The keys of the `lines`
 * map are provider line ids, not field names, so they are not inspected — their
 * contents still are.
 */
function assertNoCredentialKeys(node: unknown, keysAreIdentifiers: boolean, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoCredentialKeys(item, false, `${path}[${index}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!keysAreIdentifiers && CREDENTIAL_KEY.test(key)) refuseCredential(path, key);
    assertNoCredentialKeys(value, path === 'config' && key === 'lines', `${path}.${key}`);
  }
}

// ------------------------------------------------------------------- config

export function readConfig(): VoiceLineConfig {
  const fallback: VoiceLineConfig = { provider: 'elevenlabs', lines: {}, updatedAt: 0 };
  const stored = readJson<Partial<VoiceLineConfig>>(CONFIG_PATH, {});
  return {
    ...fallback,
    ...stored,
    provider: typeof stored.provider === 'string' && stored.provider ? stored.provider : fallback.provider,
    lines: stored.lines && typeof stored.lines === 'object' ? stored.lines : {},
    updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0,
  };
}

export function writeConfig(patch: Partial<VoiceLineConfig>): VoiceLineConfig {
  assertNoCredentialKeys(patch, false, 'config');
  const current = readConfig();
  const merged: VoiceLineConfig = {
    ...current,
    ...patch,
    lines: patch.lines ? { ...current.lines, ...patch.lines } : current.lines,
    updatedAt: nowSeconds(),
  };
  writeAtomic(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/** Called by listLines: remembers each line's carrier so hang-up can be resolved. */
export function recordLines(lines: Line[]): void {
  if (lines.length === 0) return;
  const entries: Record<string, LineConfig> = {};
  for (const line of lines) {
    entries[line.id] = {
      number: line.number,
      label: line.label,
      carrier: line.carrier,
      personaId: line.answeredBy ? line.answeredBy.id : null,
    };
  }
  writeConfig({ lines: entries });
}

export function getLineConfig(lineId: string): LineConfig | null {
  return readConfig().lines[lineId] ?? null;
}

// -------------------------------------------------------------------- state

function emptyMemory(): SweepMemory {
  return { reported: {}, firstSeen: {}, abandoned: {} };
}

/** A map read back from disk may be anything; unusable entries are dropped, not trusted. */
function readMap<T extends number | null>(node: unknown, allowNull: boolean): Record<string, T> {
  const out: Record<string, T> = {};
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value as T;
    else if (allowNull && value === null) out[key] = null as T;
  }
  return out;
}

function readMemory(node: unknown): SweepMemory {
  const record = node && typeof node === 'object' ? (node as Record<string, unknown>) : {};
  return {
    reported: readMap<number | null>(record.reported, true),
    firstSeen: readMap<number>(record.firstSeen, false),
    abandoned: readMap<number>(record.abandoned, false),
  };
}

export function readState(): VoiceLineState {
  const fallback: VoiceLineState = {
    watermarks: { inbound: 0, outbound: 0 },
    lastSweep: { inbound: 0, outbound: 0 },
    sweep: { inbound: emptyMemory(), outbound: emptyMemory() },
  };
  const stored = readJson<Partial<VoiceLineState>>(STATE_PATH, {});
  const sweep = (stored.sweep ?? {}) as Partial<Record<CallDirection, unknown>>;
  return {
    watermarks: { ...fallback.watermarks, ...(stored.watermarks ?? {}) },
    lastSweep: { ...fallback.lastSweep, ...(stored.lastSweep ?? {}) },
    sweep: { inbound: readMemory(sweep.inbound), outbound: readMemory(sweep.outbound) },
  };
}

export function writeState(patch: Partial<VoiceLineState>): VoiceLineState {
  const current = readState();
  const merged: VoiceLineState = {
    watermarks: { ...current.watermarks, ...(patch.watermarks ?? {}) },
    lastSweep: { ...current.lastSweep, ...(patch.lastSweep ?? {}) },
    sweep: { ...current.sweep, ...(patch.sweep ?? {}) },
  };
  writeAtomic(STATE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export function readSweepMemory(direction: CallDirection): SweepMemory {
  return readState().sweep[direction];
}

/**
 * Caps each map before writing. Entries are dropped oldest-first — closest to
 * the watermark, so likeliest to fall out of reach anyway — and an entry with no
 * timestamp is dropped LAST, because it is the one whose re-fetchability nothing
 * else can rule out. Returns the eviction count per map: every one of them is a
 * call that may now be reported or announced a second time, so the caller has to
 * say so out loud.
 */
export function writeSweepMemory(
  direction: CallDirection, memory: SweepMemory,
): { reported: number; firstSeen: number; abandoned: number } {
  const rank = (value: number | null | undefined): number => (typeof value === 'number' ? value : Number.POSITIVE_INFINITY);
  const capped = <T extends number | null>(map: Record<string, T>): [Record<string, T>, number] => {
    const keys = Object.keys(map);
    if (keys.length <= SWEEP_MEMORY_MAX) return [map, 0];
    const ranked = keys.sort((a, b) => {
      const [left, right] = [rank(map[a]), rank(map[b])];
      return left === right ? 0 : left - right;
    });
    const kept: Record<string, T> = {};
    for (const key of ranked.slice(keys.length - SWEEP_MEMORY_MAX)) kept[key] = map[key] as T;
    return [kept, keys.length - SWEEP_MEMORY_MAX];
  };

  const [reported, reportedEvicted] = capped(memory.reported);
  const [firstSeen, firstSeenEvicted] = capped(memory.firstSeen);
  const [abandoned, abandonedEvicted] = capped(memory.abandoned);
  writeState({ sweep: { ...readState().sweep, [direction]: { reported, firstSeen, abandoned } } });
  return { reported: reportedEvicted, firstSeen: firstSeenEvicted, abandoned: abandonedEvicted };
}

export function getWatermark(direction: CallDirection): number {
  const value = readState().watermarks[direction];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function setWatermark(direction: CallDirection, unixSeconds: number): void {
  writeState({ watermarks: { ...readState().watermarks, [direction]: Math.floor(unixSeconds) } });
}

export function setLastSweep(direction: CallDirection, unixSeconds: number): void {
  writeState({ lastSweep: { ...readState().lastSweep, [direction]: Math.floor(unixSeconds) } });
}

// ----------------------------------------------------------------- call log

export function appendCall(entry: Record<string, unknown>): void {
  ensureDir(STATE_DIR);
  const line = `${JSON.stringify({ loggedAt: nowSeconds(), ...entry })}\n`;
  const existing = existsSync(CALL_LOG_PATH) ? readFileSync(CALL_LOG_PATH, 'utf8') : '';
  const combined = existing.endsWith('\n') || existing === '' ? existing + line : `${existing}\n${line}`;
  const lines = combined.split('\n').filter((l) => l.trim() !== '');
  const kept = lines.length > CALL_LOG_MAX_LINES ? lines.slice(lines.length - CALL_LOG_MAX_LINES) : lines;
  writeAtomic(CALL_LOG_PATH, `${kept.join('\n')}\n`);
}

export function readCallLog(limit?: number): Record<string, unknown>[] {
  if (!existsSync(CALL_LOG_PATH)) return [];
  let raw = '';
  try {
    raw = readFileSync(CALL_LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const parsed: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') parsed.push(value as Record<string, unknown>);
    } catch {
      /* skip a torn line rather than fail the whole read */
    }
  }
  if (limit === undefined || limit <= 0 || parsed.length <= limit) return parsed;
  return parsed.slice(parsed.length - limit);
}

// ---------------------------------------------------------------- campaigns

function campaignPath(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === '' || safe === '.' || safe === '..') {
    throw new VoiceToolError(`"${id}" is not a usable campaign id.`, {
      code: 'usage',
      exitCode: ExitCode.USAGE,
    });
  }
  return `${CAMPAIGN_DIR}/${safe}.json`;
}

export function saveCampaign(id: string, record: Record<string, unknown>): void {
  // Generated fields last: callers round-trip a stored record (read, merge, save)
  // and a leading `savedAt` would be overwritten by the stale one it carries.
  writeAtomic(campaignPath(id), `${JSON.stringify({ ...record, id, savedAt: nowSeconds() }, null, 2)}\n`);
}

export function readCampaign(id: string): Record<string, unknown> | null {
  const path = campaignPath(id);
  if (!existsSync(path)) return null;
  return readJson<Record<string, unknown> | null>(path, null);
}
