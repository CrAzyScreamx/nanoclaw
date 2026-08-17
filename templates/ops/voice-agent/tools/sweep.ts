#!/usr/bin/env bun
// ============================================================================
// sweep.ts — the scheduled-task gate.
//
//   bun sweep.ts <inbound|outbound> [--limit N] [--since UNIX] [--dry-run]
//
// This is the ONE tool that does not use emit()'s {"ok":…} wrapper, because the
// gate contract owns stdout:
//
//   the LAST stdout line must be exactly one JSON object with a boolean
//   `wakeAgent`. Anything else counts as a broken script to the runner.
//
//   {"wakeAgent": true, "direction": "inbound", "truncated": 0, "complete": true,
//    "calls": [ … ]}
//   {"wakeAgent": false}
//
// Every diagnostic goes to stderr, and nothing ever throws out of this process:
// an auth failure, an upstream 500 or a torn state file all end as
// {"wakeAgent": false} with exit code 0 and an explanation on stderr.
//
// THE WATERMARK RULE, which is the whole correctness story here. The upstream
// filter is a START time (`call_start_after_unix`) but a call becomes reportable
// at its END, so a watermark that advances to the newest call it reported buries
// every call that was still running underneath it — on a */10 schedule that is
// every call longer than ten minutes and every pair of overlapping calls. So:
//
//   1. the watermark never advances past the start of the oldest call still
//      running in the window (the pin), and never past the newest call actually
//      reported, and always lands one second BELOW that, since the upstream
//      filter is exclusive and several calls can share a second;
//   2. it does not advance AT ALL on a window the provider could not enumerate
//      in full — the rows it never saw are always the oldest ones;
//   3. re-fetching what has already been delivered is therefore normal, and the
//      dedup memory in state.json (not the trimmed calls.jsonl) is what stops a
//      call being reported twice.
//
// A call is reportable when it is FINISHED, which means `done` or `failed`. A
// failed call is an outcome the agent has to hear about: the dial rail says
// never re-dial on silence because the outcome arrives here.
//
// Gate scripts run with the container's own environment, so HTTPS_PROXY and
// NODE_EXTRA_CA_CERTS are inherited exactly as they are for a tool the agent
// runs by hand — there is no proxy recovery logic to do here.
//
// The runner caps this script at 30s and 1MB of output. Hence the self-imposed
// ~25s budget below, the shorter enumeration budget inside it, the 15-call cap
// per fire, and summaries truncated to 600 characters with no transcripts.
// ============================================================================

import { flag, flagBool, parseArgv } from './lib/cli.ts';
import type { CallDirection, CallStatus, CallSummary } from './lib/provider.ts';
import { getProvider } from './lib/registry.ts';
import {
  appendCall, getWatermark, nowSeconds, readCallLog, readSweepMemory,
  setLastSweep, setWatermark, writeSweepMemory, type SweepMemory,
} from './lib/state.ts';

const MAX_CALLS = 15;
/**
 * How many rows one fire may READ. It is the client's own ceiling
 * (MAX_PAGES × page_size), so asking for it means "enumerate everything since
 * the watermark" — anything less would make `truncated` a guess, and the pin
 * below is only sound over a window that was read to the end.
 */
const SCAN_MAX = 1000;
const BUDGET_MS = 25_000;
/** Leaves the fire time to write state and print after the provider answers. */
const SCAN_BUDGET_MS = 18_000;
const SUMMARY_MAX = 600;
const FIRST_RUN_LOOKBACK_SEC = 3600;
/**
 * How long a call may pin the watermark before the sweep stops waiting for it.
 * Without this, one wedged `processing` row — or one status this provider map
 * has never heard of — freezes the watermark for good. When it bites the sweep
 * says so in the payload rather than in a stderr line nobody reads.
 */
const PIN_TTL_SEC = 6 * 3600;

/** Finished, one way or the other. Everything else is still in flight. */
const TERMINAL: readonly CallStatus[] = ['done', 'failed'];

type Payload =
  | { wakeAgent: false }
  | {
      wakeAgent: true;
      direction: CallDirection;
      truncated: number;
      /**
       * False when the provider could not read the whole backlog this fire, so
       * `truncated` is a lower bound and older calls exist that were not seen.
       */
      complete: boolean;
      calls: CallSummary[];
      /** Ids that never reached a finished state within PIN_TTL_SEC. Announced once. */
      abandoned?: string[];
    };

const QUIET: Payload = { wakeAgent: false };

const USAGE = [
  'sweep.ts — scheduled-task gate: reports calls that finished since the last fire.',
  '',
  'Usage: bun sweep.ts <inbound|outbound> [flags]',
  '',
  'Flags:',
  '  --limit N     maximum calls to report this fire (default 15, hard cap 15)',
  '  --since UNIX  override the stored watermark for this run only; may repeat',
  '                calls a previous fire already reported',
  '  --dry-run     report without advancing the watermark or writing calls.jsonl',
  '  --help, -h    this help',
  '',
  'Prints exactly one JSON object on stdout: {"wakeAgent":true,…} or {"wakeAgent":false}.',
].join('\n');

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function truncate(text: string | null): string | null {
  if (!text) return text;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

/** A CallSummary carries no transcript; this only trims the free text. */
function forPrompt(call: CallSummary): CallSummary {
  return { ...call, summary: truncate(call.summary), title: truncate(call.title) };
}

function parseDirection(value: string | null): CallDirection | null {
  if (value === 'inbound' || value === 'outbound') return value;
  return null;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function isFinished(call: CallSummary): boolean {
  return TERMINAL.includes(call.status);
}

/** The newest start time in a set, or null when not one row carries a usable one. */
function newestStart(calls: CallSummary[]): number | null {
  let newest: number | null = null;
  for (const call of calls) {
    if (typeof call.startedAt === 'number' && (newest === null || call.startedAt > newest)) {
      newest = call.startedAt;
    }
  }
  return newest;
}

/**
 * Ids a previous fire already delivered: the state.json memory, plus any
 * `event: "swept"` line still in calls.jsonl as a second belt. The marker is
 * what makes the union safe — dial events in the same log carry the same call
 * under a different key and must NOT suppress its later report.
 */
function reportedIds(memory: SweepMemory): Set<string> {
  const ids = new Set<string>(Object.keys(memory.reported));
  for (const entry of readCallLog()) {
    if (entry.event === 'swept' && typeof entry.id === 'string') ids.add(entry.id);
  }
  return ids;
}

interface Pin {
  id: string;
  /** The start time it pins at, or null when the row carried none. */
  at: number | null;
}

/**
 * Splits the calls still in flight into the ones that still hold the watermark
 * back and the ones whose TTL has run out. A row without a start time has no
 * clock of its own, so the first fire that sees it records one; until its TTL
 * expires it blocks any advance at all, being the one row whose position
 * relative to the watermark cannot be computed.
 */
function classifyPins(
  live: CallSummary[], memory: SweepMemory, now: number,
): { active: Pin[]; expired: string[]; firstSeen: Record<string, number> } {
  const active: Pin[] = [];
  const expired: string[] = [];
  const firstSeen: Record<string, number> = {};

  for (const call of live) {
    const basis = call.startedAt ?? memory.firstSeen[call.id] ?? now;
    if (call.startedAt === null) firstSeen[call.id] = basis;
    if (now - basis > PIN_TTL_SEC) expired.push(call.id);
    else active.push({ id: call.id, at: call.startedAt });
  }
  return { active, expired, firstSeen };
}

async function run(): Promise<Payload> {
  const args = parseArgv(process.argv.slice(2));
  const direction = parseDirection(args.command);
  if (!direction) {
    note(`sweep.ts needs a direction: inbound or outbound (got "${args.command ?? 'nothing'}").`);
    return QUIET;
  }

  const dryRun = flagBool(args, 'dry-run');
  const requested = parseNumber(flag(args, 'limit'));
  const max = requested !== null && requested > 0 ? Math.min(requested, MAX_CALLS) : MAX_CALLS;

  const stored = getWatermark(direction);
  const override = parseNumber(flag(args, 'since'));
  const since = override ?? (stored > 0 ? stored : nowSeconds() - FIRST_RUN_LOOKBACK_SEC);
  if (stored === 0 && override === null) {
    note(`No ${direction} watermark yet; looking back ${FIRST_RUN_LOOKBACK_SEC}s so the first fire does not replay history.`);
  }

  const provider = await getProvider();
  // No direction filter on the way out, on purpose: a call still in flight may
  // carry no direction yet, and such a row has to be able to pin THIS
  // direction's watermark. Filtering happens below, after the pin is computed.
  // oldestFirst matters too: the endpoint answers newest-first, and a watermark
  // that advanced past the newest of a truncated page would bury every older
  // call still waiting underneath it.
  const window = await provider.listCallWindow({
    startedAfter: since, limit: SCAN_MAX, scan: SCAN_MAX,
    scanBudgetMs: SCAN_BUDGET_MS, oldestFirst: true,
  });

  // ---- everything from here down is synchronous ON PURPOSE. The 25s budget
  // race below can only resolve at an await, so keeping this stretch await-free
  // is what stops the watermark advancing on a fire that reported nothing.
  const now = nowSeconds();
  const rows = window.calls;
  const memory = readSweepMemory(direction);

  // A row with no direction belongs to whichever sweep sees it first — for
  // reporting AND for pinning. It cannot be left to "the other one": it matches
  // neither direction filter, so leaving it out of both partitions would make it
  // invisible to the report and invisible to the pin, and the watermark would
  // step straight over it. Reporting one is recorded against both directions.
  const mine = (call: CallSummary): boolean => call.direction === direction || call.direction === null;
  const finished = rows
    .filter((call) => mine(call) && isFinished(call))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const live = rows.filter((call) => mine(call) && !isFinished(call));

  const alreadyReported = reportedIds(memory);
  const fresh = finished.filter((call) => !alreadyReported.has(call.id));
  const emitted = fresh.slice(0, max);
  const truncated = fresh.length - emitted.length;

  const { active, expired, firstSeen } = classifyPins(live, memory, now);
  const newlyAbandoned = expired.filter((id) => memory.abandoned[id] === undefined);
  // A directionless call belongs to both sweeps, so an abandonment announced by
  // one has to be recorded for the other as well — otherwise one wedged call
  // wakes the agent twice with the same news.
  const directionless = new Set(live.filter((call) => call.direction === null).map((call) => call.id));
  const sharedAbandoned = newlyAbandoned.filter((id) => directionless.has(id));

  if (truncated > 0) {
    note(
      `${truncated} further finished ${direction} call(s) are waiting; the watermark stops at the ` +
        'last reported one and reported ids are skipped, so the next fire picks them up.',
    );
  }
  if (!window.complete) {
    note(
      'The provider could not enumerate the whole backlog this fire (page, row or time cap), so the ' +
        `${direction} watermark is being held where it is. Nothing is lost — the unread rows are the ` +
        'oldest ones and stay above the watermark — but note the unreported rows below the window ' +
        'bottom stay unreported until the backlog fits in one read, which needs fewer than ' +
        `${SCAN_MAX} calls since the watermark.`,
    );
  }
  if (newlyAbandoned.length > 0) {
    note(
      `${newlyAbandoned.length} ${direction} call(s) never reached a finished state within ` +
        `${PIN_TTL_SEC}s and are no longer holding the watermark: ${newlyAbandoned.join(', ')}.`,
    );
  }
  for (const call of live) {
    if (call.status === 'unknown') {
      note(`Call ${call.id} carries a status this provider map does not know; it counts as unfinished, which holds the watermark rather than dropping the call.`);
    }
  }

  if (emitted.length === 0 && newlyAbandoned.length === 0) {
    note(`No new finished ${direction} calls since ${since}.`);
  }

  if (dryRun) {
    note('--dry-run: not advancing the watermark, not writing calls.jsonl and not remembering anything.');
  } else {
    persist({ direction, emitted, active, firstSeen, newlyAbandoned, sharedAbandoned, memory, window, rows, stored, now });
  }

  if (emitted.length === 0 && newlyAbandoned.length === 0) return QUIET;
  return {
    wakeAgent: true, direction, truncated, complete: window.complete, calls: emitted.map(forPrompt),
    ...(newlyAbandoned.length > 0 ? { abandoned: newlyAbandoned } : {}),
  };
}

interface PersistInput {
  direction: CallDirection;
  emitted: CallSummary[];
  active: Pin[];
  firstSeen: Record<string, number>;
  newlyAbandoned: string[];
  /** The subset of newlyAbandoned that carried no direction, so both sweeps own them. */
  sharedAbandoned: string[];
  memory: SweepMemory;
  window: { complete: boolean };
  rows: CallSummary[];
  stored: number;
  now: number;
}

/** The whole write side of a fire: call log, watermark, dedup memory. Synchronous. */
function persist(input: PersistInput): void {
  const { direction, emitted, memory, now } = input;

  for (const call of emitted) {
    try {
      appendCall({
        event: 'swept', direction, id: call.id, startedAt: call.startedAt,
        status: call.status, summary: truncate(call.summary),
      });
    } catch (error) {
      note(`Could not append ${call.id} to the call log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const call of emitted) memory.reported[call.id] = call.startedAt;
  for (const [id, at] of Object.entries(input.firstSeen)) memory.firstSeen[id] = at;
  for (const id of input.newlyAbandoned) memory.abandoned[id] = now;

  // A reported call that carried no direction was claimed by whichever sweep got
  // to it first, so the OTHER direction has to remember it too — its watermark
  // is its own and may still be low enough to re-fetch the same row, and each
  // map has to be prunable against its own watermark to stay consistent.
  const shared = emitted.filter((call) => call.direction === null);
  if (shared.length > 0 || input.sharedAbandoned.length > 0) {
    const other: CallDirection = direction === 'inbound' ? 'outbound' : 'inbound';
    const otherMemory = readSweepMemory(other);
    for (const call of shared) otherMemory.reported[call.id] = call.startedAt;
    for (const id of input.sharedAbandoned) otherMemory.abandoned[id] = now;
    writeSweepMemory(other, otherMemory);
  }

  const watermark = nextWatermark(input);
  if (watermark !== null) {
    setWatermark(direction, watermark);
    // Only entries that can still come back in a future window are worth
    // keeping: the upstream filter is exclusive, so a call is re-fetchable
    // exactly while its start is ABOVE the watermark. A remembered call with no
    // start time is never pruned here — nothing can prove it unreachable.
    for (const [id, startedAt] of Object.entries(memory.reported)) {
      if (typeof startedAt === 'number' && startedAt <= watermark) delete memory.reported[id];
    }
  }

  // A complete window that did not contain an id means that id is gone or has
  // fallen below the watermark, so its pin bookkeeping can go too — but only
  // once the entry is older than the pin TTL. An upstream that transiently drops
  // a row from one otherwise-complete listing would otherwise reset its clock or
  // re-arm an announcement it already made.
  if (input.window.complete) {
    const present = new Set(input.rows.map((call) => call.id));
    const stale = (at: number): boolean => now - at > PIN_TTL_SEC;
    for (const [id, at] of Object.entries(memory.firstSeen)) {
      if (!present.has(id) && stale(at)) delete memory.firstSeen[id];
    }
    for (const [id, at] of Object.entries(memory.abandoned)) {
      if (!present.has(id) && stale(at)) delete memory.abandoned[id];
    }
  }

  const evicted = writeSweepMemory(direction, memory);
  if (evicted.reported > 0 || evicted.firstSeen > 0 || evicted.abandoned > 0) {
    note(
      `The ${direction} sweep memory hit its cap and dropped ${evicted.reported} remembered call id(s), ` +
        `${evicted.firstSeen} pin clock(s) and ${evicted.abandoned} abandonment note(s); calls behind those ` +
        'entries may be reported or announced a second time.',
    );
  }
  setLastSweep(direction, now);
}

/**
 * The watermark this fire may write, or null to leave it where it is. Never
 * above the newest call reported, never above the oldest call still running,
 * always one second below whichever of those binds, and never below where it
 * already stood (a `--since` override moves the window, not the memory).
 */
function nextWatermark(input: PersistInput): number | null {
  if (!input.window.complete) return null;
  if (input.active.some((pin) => pin.at === null)) return null;

  const pinFloor = input.active.reduce<number | null>(
    (floor, pin) => (pin.at !== null && (floor === null || pin.at < floor) ? pin.at : floor),
    null,
  );
  // With nothing reported this fire there is no unreported call below the newest
  // row either, so the whole enumerated window can be stepped over.
  const reportedCap = input.emitted.length > 0 ? newestStart(input.emitted) : newestStart(input.rows);
  const bounds = [pinFloor, reportedCap].filter((value): value is number => value !== null);
  if (bounds.length === 0) return null;

  return Math.max(input.stored, Math.min(...bounds) - 1);
}

function budget(): Promise<Payload> {
  return new Promise((resolve) => {
    setTimeout(() => {
      note(`sweep.ts hit its ${BUDGET_MS}ms budget before the provider answered; reporting nothing this fire.`);
      resolve(QUIET);
    }, BUDGET_MS);
  });
}

async function main(): Promise<void> {
  // --help is answered before anything can touch the network.
  const preview = parseArgv(process.argv.slice(2));
  if (preview.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const guarded = run().catch((error: unknown) => {
    note(error instanceof Error ? error.message : String(error));
    const hint = (error as { hint?: string | null } | null)?.hint;
    if (hint) note(hint);
    return QUIET;
  });

  const payload = await Promise.race([guarded, budget()]);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

void main();
