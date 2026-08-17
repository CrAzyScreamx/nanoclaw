#!/usr/bin/env bun
/**
 * call.ts — place one outbound call, and end one that is still running.
 *
 * Two rails are built into the tool rather than left to prose:
 *
 *   1. `dial` without --yes NEVER dials. It prints the confirmation block —
 *      callee, number, persona, every variable value — and exits 6. One
 *      approval covers one call; the tool remembers no previous yes.
 *   2. `hangup` with no id and more than one live call REFUSES and lists them,
 *      rather than guessing which call to kill.
 *
 * No auth header is set: the OneCLI gateway injects by destination host.
 */
import {
  runTool,
  emit,
  flagBool,
  keyValueFlag,
  requireFlag,
  type CommandContext,
  type CommandSpec,
  type ToolSpec,
} from './lib/cli.ts';
import { getProvider } from './lib/registry.ts';
import {
  AmbiguousTargetError,
  ConfirmationRequiredError,
  ExitCode,
  UnsupportedCapabilityError,
  VoiceToolError,
  type CallSummary,
  type CarrierValue,
  type HangUpStrategy,
  type PlaceCallInput,
} from './lib/provider.ts';
import { appendCall, getLineConfig, readConfig } from './lib/state.ts';
import { carrierFor } from './carriers/index.ts';

const ENDING_REF = 'skills/voice-line/references/ending-a-call.md';

// --------------------------------------------------------------------- helpers

/**
 * The carrier is never defaulted: it is whatever the line is actually carried
 * on. config.json is the fast path; a miss re-surveys the lines, which also
 * re-records them.
 */
async function carrierForLine(
  provider: Awaited<ReturnType<typeof getProvider>>,
  lineId: string,
): Promise<{ carrier: CarrierValue; number: string; label: string }> {
  const known = getLineConfig(lineId);
  if (known) return { carrier: known.carrier, number: known.number, label: known.label };
  const lines = await provider.listLines();
  const line = lines.find((l) => l.id === lineId);
  if (!line) {
    throw new VoiceToolError(
      `No line with id "${lineId}" on this account. Run lines.ts list to see the ids.`,
      { code: 'not_found', exitCode: ExitCode.NOT_FOUND },
    );
  }
  return { carrier: line.carrier, number: line.number, label: line.label };
}

/** Whether the carrier adapter for `kind` can end a call, and why not if it cannot. */
function carrierState(kind: CarrierValue | null): { reason: string | null } {
  try {
    return { reason: carrierFor(kind, readConfig()).unavailable };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

function describeStrategy(strategy: HangUpStrategy): string {
  return strategy === 'carrier'
    ? "the carrier route (the phone network dropped the call)"
    : 'the monitor WebSocket control channel';
}

/**
 * One line per live call, for the disambiguation prompt. Phone numbers are NOT
 * shown: the list endpoint does not carry them, so they would print as "?" and
 * make the choice harder rather than easier. Persona, title and start time are
 * what the list can actually fill; `calls.ts show <id>` has the numbers.
 */
function liveRow(c: CallSummary): string {
  const started = c.startedAt
    ? new Date(c.startedAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
    : '—';
  return `  ${c.id}  ${c.status.padEnd(11)}  started ${started}  ${
    c.personaName ?? c.personaId ?? 'unknown persona'
  }  ${c.title ?? 'no title yet'}`;
}

// ---------------------------------------------------------------------- dial

const dialCommand: CommandSpec = {
  name: 'dial',
  summary: 'Place one outbound call. Requires --yes; without it, prints the confirmation block.',
  usage:
    'call.ts dial --to <e164> --line <lineId> --persona <personaId> [--var k=v ...] [--yes] [--json]',
  async run(ctx: CommandContext) {
    const to = requireFlag(ctx.args, 'to');
    const lineId = requireFlag(ctx.args, 'line');
    const personaId = requireFlag(ctx.args, 'persona');
    const variables = keyValueFlag(ctx.args, 'var');   // --var name=Dana --var order=A17
    const approved = flagBool(ctx.args, 'yes', false);

    const provider = await getProvider();
    const line = await carrierForLine(provider, lineId);

    // Best effort only: a readable name in the confirmation block, and a 404
    // here is worth hitting BEFORE the call rather than during it.
    let personaName = personaId;
    try {
      personaName = (await provider.getPersona(personaId)).name || personaId;
    } catch {
      /* fall back to the id; placeCall will surface a bad id properly */
    }

    if (!approved) {
      const varLines = Object.keys(variables).length
        ? Object.entries(variables).map(([k, v]) => `    ${k} = ${v}`).join('\n')
        : '    (none)';
      throw new ConfirmationRequiredError(
        'Nothing has been dialed. Confirm this with the user, word for word:\n' +
          `  calling:   ${to}\n` +
          `  from:      ${line.number} (${line.label || lineId}, carrier ${line.carrier})\n` +
          `  persona:   ${personaName} (${personaId})\n` +
          '  variables:\n' +
          `${varLines}\n` +
          'Re-run with --yes after the user says yes. One approval covers one call: a ' +
          'corrected number or a retry needs a fresh yes.',
        'skills/voice-line/references/placing-calls.md',
      );
    }

    const input: PlaceCallInput = {
      lineId,
      personaId,
      toNumber: to,
      carrier: line.carrier,
      ...(Object.keys(variables).length ? { variables } : {}),
    };
    const handle = await provider.placeCall(input);
    // `id` is the call-log's key for a call, in every event it records — the
    // sweep's `event: 'swept'` lines use it too. What separates a dial from a
    // report is the `event` field, never the spelling of the id.
    appendCall({
      at: Math.floor(Date.now() / 1000),
      event: 'dial',
      id: handle.conversationId,
      callSid: handle.callSid,
      carrier: handle.carrier,
      lineId,
      personaId,
      toNumber: to,
      variables,
      accepted: handle.accepted,
      message: handle.message,
    });

    emit(ctx, { call: handle, lineId, personaId, toNumber: to, variables }, (d) => {
      console.log(
        d.call.accepted
          ? 'The provider accepted the call.'
          : `The provider did not accept the call: ${d.call.message ?? 'no reason given'}`,
      );
      console.log(`  conversation: ${d.call.conversationId}`);
      console.log(`  call sid:     ${d.call.callSid ?? '— (not returned)'} (${d.call.carrier})`);
      if (d.call.message && d.call.accepted) console.log(`  note:         ${d.call.message}`);
      console.log(
        '\nThe outcome arrives later — through the outbound sweep, or from ' +
          `calls.ts show ${d.call.conversationId}.\n` +
          'DO NOT re-dial on silence: quiet means the call is still running.',
      );
    });
  },
};

// -------------------------------------------------------------------- hangup

const hangupCommand: CommandSpec = {
  name: 'hangup',
  summary: 'End a call that is still running, and name the route it took.',
  usage: 'call.ts hangup [<conversationId>] [--dry-run] [--json]',
  async run(ctx: CommandContext) {
    const provider = await getProvider();
    let id = ctx.args.positionals[0];
    let live: CallSummary[] = [];

    if (!id) {
      live = await provider.listCalls({ live: true });
      if (live.length === 0) {
        emit(ctx, { live: [], ended: null }, () => {
          console.log('No live calls right now — nothing to hang up.');
        });
        return;
      }
      if (live.length > 1) {
        throw new AmbiguousTargetError(
          `${live.length} calls are live. Refusing to guess which one to end — ` +
            'name it explicitly with call.ts hangup <conversationId>:\n' +
            live.map(liveRow).join('\n'),
          ENDING_REF,
        );
      }
      id = live[0]!.id;
    }

    if (flagBool(ctx.args, 'dry-run', false)) {
      // A dry run is allowed the extra detail fetch; the live path is not, since
      // hangUp() resolves the same thing itself.
      const report = await provider.getCall(id);
      const { reason } = carrierState(report.carrier);
      emit(
        ctx,
        {
          conversationId: id,
          carrier: report.carrier,
          callSid: report.callSid,
          status: report.status,
          strategies: provider.capabilities.hangUp,
          carrierBlockedBecause: reason,
          dryRun: true,
        },
        (d) => {
          console.log(`Would end ${d.conversationId} (status ${d.status}). Nothing was sent.`);
          console.log(`  carrier:  ${d.carrier ?? '—'}`);
          console.log(`  call sid: ${d.callSid ?? '— (none recorded; the carrier route needs it)'}`);
          console.log(
            `  routes available on this install: ${
              d.strategies.length ? d.strategies.join(', ') : 'none'
            }`,
          );
          if (d.carrierBlockedBecause) {
            console.log(`  carrier route unavailable: ${d.carrierBlockedBecause}`);
          }
        },
      );
      return;
    }

    let strategy: HangUpStrategy;
    try {
      strategy = await provider.hangUp(id);
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        // The provider carries the carrier's own named reason in this message —
        // it is never a bare "unsupported".
        throw new VoiceToolError(
          `${err.message}\n` +
            'The route that always works is the `end_call` system tool on the persona: ' +
            'it is configuration rather than live control, but it works on every plan ' +
            'and every carrier. Add it with personas.ts update <personaId> ' +
            '--end-call-tool, and it applies from the next call onward — not to this one.',
          { code: 'unsupported_capability', exitCode: ExitCode.UNSUPPORTED, hint: ENDING_REF },
        );
      }
      throw err;
    }

    const record = { conversationId: id, strategy, endedAt: Math.floor(Date.now() / 1000) };
    appendCall({ at: record.endedAt, event: 'hangup', id, strategy, endedAt: record.endedAt });
    emit(ctx, record, (d) => {
      console.log(`Ended ${d.conversationId} via ${describeStrategy(d.strategy)}.`);
    });
  },
};

const spec: ToolSpec = {
  tool: 'call.ts',
  summary: 'Place a single outbound call, or end a call that is still running.',
  commands: [dialCommand, hangupCommand],
};

await runTool(spec, Bun.argv.slice(2));
