#!/usr/bin/env bun
/**
 * calls.ts — what happened on the line: list calls, and read one in full.
 *
 * `list --live` is the lookup that feeds `call.ts hangup`: it filters to the
 * statuses that mean the call is still running (initiated / in-progress /
 * processing).
 *
 * `show <id>` also prints the carrier-side call sid, because that is the id
 * every hang-up route needs.
 *
 * No auth header is set: the OneCLI gateway injects by destination host.
 */
import {
  runTool,
  emit,
  flag,
  flagBool,
  formatTable as table,
  type CommandContext,
  type CommandSpec,
  type ToolSpec,
} from './lib/cli.ts';
import { getProvider } from './lib/registry.ts';
import {
  ExitCode,
  LIVE_STATUSES,
  VoiceToolError,
  type CallDirection,
  type CallFilter,
  type CallSummary,
} from './lib/provider.ts';

// --------------------------------------------------------------------- helpers

function usage(message: string): VoiceToolError {
  return new VoiceToolError(message, { code: 'usage', exitCode: ExitCode.USAGE });
}

function stamp(unix: number | null): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function duration(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function clock(sec: number | null): string {
  if (sec === null || sec === undefined) return '  --:--';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(3, ' ')}:${String(s).padStart(2, '0')}`;
}

/** `--since` takes unix seconds or anything Date.parse understands. */
function parseSince(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw usage(`--since expects unix seconds or an ISO-8601 timestamp — got "${value}".`);
  }
  return Math.floor(ms / 1000);
}

function parseDirection(value: string | undefined): CallDirection | undefined {
  if (value === undefined) return undefined;
  if (value !== 'inbound' && value !== 'outbound') {
    throw usage('--direction takes inbound or outbound.');
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usage('--limit takes a positive whole number.');
  return n;
}

// The list endpoint carries no phone numbers — those only arrive on the detail
// fetch — so the columns here are the ones the list can actually fill. Numbers
// show up in `calls.ts show <id>`.
function row(c: CallSummary): string[] {
  return [
    c.id,
    c.direction ?? '—',
    c.status,
    stamp(c.startedAt),
    duration(c.durationSec),
    c.personaName ?? c.personaId ?? '—',
    c.title ?? '—',
    c.successful,
  ];
}

// ------------------------------------------------------------------- commands

const listCommand: CommandSpec = {
  name: 'list',
  summary: 'List calls. --live shows only the ones still running.',
  usage:
    'calls.ts list [--live] [--direction inbound|outbound] [--since <unix|ISO>] ' +
    '[--limit N] [--persona <personaId>] [--json]',
  async run(ctx: CommandContext) {
    const live = flagBool(ctx.args, 'live', false);
    const direction = parseDirection(flag(ctx.args, 'direction'));
    const startedAfter = parseSince(flag(ctx.args, 'since'));
    const limit = parseLimit(flag(ctx.args, 'limit'));
    const personaId = flag(ctx.args, 'persona');

    const filter: CallFilter = {
      ...(live ? { live: true } : {}),
      ...(direction ? { direction } : {}),
      ...(startedAfter !== undefined ? { startedAfter } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(personaId ? { personaId } : {}),
    };

    const provider = await getProvider();
    const calls = await provider.listCalls(filter);
    emit(ctx, { calls, filter }, (d) => {
      if (d.calls.length === 0) {
        console.log(
          live
            ? `No live calls (${LIVE_STATUSES.join(', ')}).`
            : 'No calls match that filter.',
        );
        return;
      }
      console.log(
        table(
          ['ID', 'DIR', 'STATUS', 'STARTED', 'DUR', 'PERSONA', 'TITLE', 'OUTCOME'],
          d.calls.map(row),
        ),
      );
      if (live) {
        console.log(
          `\n${d.calls.length} call${d.calls.length === 1 ? '' : 's'} still running. ` +
            'End one with: call.ts hangup <id>',
        );
      } else {
        console.log('\nRead one in full with: calls.ts show <id> --transcript');
      }
    });
  },
};

const showCommand: CommandSpec = {
  name: 'show',
  summary: 'Show one call in full: summary, outcome, collected data, optionally the transcript.',
  usage: 'calls.ts show <conversationId> [--transcript] [--json]',
  async run(ctx: CommandContext) {
    const id = ctx.args.positionals[0];
    if (!id) throw usage('show needs a conversation id: calls.ts show <conversationId>');
    const wantTranscript = flagBool(ctx.args, 'transcript', false);
    const provider = await getProvider();
    const call = await provider.getCall(id);
    emit(ctx, { call, transcript: wantTranscript }, (d) => {
      const c = d.call;
      console.log(`${c.title ?? '(untitled call)'}  (${c.id})`);
      console.log(
        `${c.direction ?? '—'}  |  status ${c.status}  |  outcome ${c.successful}  |  ` +
          `${duration(c.durationSec)}`,
      );
      console.log(`started:  ${stamp(c.startedAt)}`);
      console.log(`numbers:  ${c.fromNumber ?? '?'} -> ${c.toNumber ?? '?'}`);
      console.log(`persona:  ${c.personaName ?? '—'} (${c.personaId ?? '—'})`);
      // The carrier-side id is what every hang-up route needs; print it always.
      console.log(`call sid: ${c.callSid ?? '— (none recorded)'}  carrier: ${c.carrier ?? '—'}`);
      console.log(`\nsummary:\n  ${c.summary ?? '— none yet'}`);

      const collected = Object.entries(c.collected ?? {});
      if (collected.length) {
        console.log('\ncollected data:');
        for (const [k, v] of collected) {
          console.log(`  ${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
      }

      if (!d.transcript) {
        if (c.transcript.length) {
          console.log(
            `\n${c.transcript.length} transcript turns — add --transcript to print them.`,
          );
        }
        return;
      }
      if (c.transcript.length === 0) {
        console.log('\ntranscript: — none (the call may still be processing)');
        return;
      }
      console.log('\ntranscript:');
      for (const t of c.transcript) {
        console.log(`  ${clock(t.timeSec)}  ${t.role === 'agent' ? 'agent' : 'user '}  ${t.text}`);
      }
    });
  },
};

const spec: ToolSpec = {
  tool: 'calls.ts',
  summary: 'Call results: list what has happened on the line, and read one call in full.',
  commands: [listCommand, showCommand],
};

await runTool(spec, Bun.argv.slice(2));
