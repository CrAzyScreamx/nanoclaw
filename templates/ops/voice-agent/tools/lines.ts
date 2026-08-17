#!/usr/bin/env bun
/**
 * lines.ts — survey the phone lines this install can answer on and dial from,
 * and wire a persona to one.
 *
 * `list` is also the DETECTION step: provider.listLines() records each line's
 * carrier into /workspace/agent/voice-line/config.json, and every hang-up route
 * is resolved from there. Nothing is written inside the plugin directory.
 *
 * No auth header is set here or anywhere below it: the OneCLI gateway injects
 * credentials by destination host. A 401/403 surfaces as AuthRequiredError,
 * whose message names the exact fix and points at
 * skills/voice-line/references/connect-provider.md.
 */
import {
  runTool,
  emit,
  flag,
  flagBool,
  formatTable as table,
  refuseCredentialFlags,
  type CommandContext,
  type CommandSpec,
  type ToolSpec,
} from './lib/cli.ts';
import { getProvider } from './lib/registry.ts';
import {
  ExitCode,
  VoiceToolError,
  type CarrierKind,
  type CarrierValue,
  type Line,
} from './lib/provider.ts';
import { readConfig, writeConfig, type VoiceLineConfig } from './lib/state.ts';
import { carrierFor, carrierReadiness, HANGUP_CARRIERS } from './carriers/index.ts';

// ------------------------------------------------------------ carrier routing

interface CarrierRoute {
  route: string;
  needs: string;
}

const NO_ROUTE = 'none — this template ships no hang-up adapter for this carrier';

const ROUTES: Record<CarrierKind, CarrierRoute> = {
  twilio: {
    route: 'Twilio REST — POST /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json, Status=completed',
    needs:
      'Account SID in config.json (an identifier, not a secret) + a Twilio API Key (SID SK… and its ' +
      'secret, base64 as SK…:secret) in the OneCLI vault, host api.twilio.com — not the Auth Token',
  },
  exotel: {
    route: NO_ROUTE,
    needs: 'nothing to configure; the `status` line below says why, and what to offer instead',
  },
  sip_trunk: {
    route: NO_ROUTE,
    needs: 'nothing to configure; the `status` line below says why, and what to offer instead',
  },
};

interface RouteNote {
  carrier: CarrierKind | string;
  lines: number;
  route: string;
  needs: string;
  configured: boolean;
  unavailable: string | null;
}

function isConfigured(kind: CarrierKind | string, cfg: VoiceLineConfig): boolean {
  // Twilio is the only carrier with anything to configure, because it is the
  // only one with an adapter to configure it for.
  if (kind === 'twilio') return Boolean(cfg.twilio?.accountSid);
  return false;
}

function routeNotes(lines: Line[], cfg: VoiceLineConfig): RouteNote[] {
  const kinds = [...new Set(lines.map((l) => l.carrier))];
  return kinds.map((kind) => {
    let unavailable: string | null = null;
    try {
      unavailable = carrierFor(kind, cfg).unavailable;
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }
    const known = ROUTES[kind as CarrierKind];
    return {
      carrier: kind,
      lines: lines.filter((l) => l.carrier === kind).length,
      route: known?.route ?? 'unknown carrier — no hang-up route is known for it',
      needs: known?.needs ?? 'nothing; hang-up is not available on this carrier',
      configured: isConfigured(kind, cfg),
      unavailable,
    };
  });
}

const OPTIONAL_NOTE =
  'The carrier credential is OPTIONAL. Dialing, answering and reporting all work\n' +
  'without it — it buys hang-up and nothing else. The `end_call` system tool on the\n' +
  'persona ends calls on every carrier and every plan; see references/ending-a-call.md.';

// ------------------------------------------------------------- credential probe

/**
 * `--check` exists because the alternative is discovering a wrong vault entry
 * from a 401 during a live call. Each carrier that has a harmless read-only
 * request makes it; the ones that do not say so, rather than being reported as
 * fine by default.
 */
type ProbeStatus = 'pass' | 'fail' | 'no-probe' | 'not-configured';

interface CarrierProbe {
  kind: CarrierKind;
  status: ProbeStatus;
  /** The request that was actually sent, or null when none was. */
  probe: string | null;
  detail: string;
}

const NO_PROBE =
  'this carrier has no read-only request that would prove its credential, so nothing was ' +
  'sent. Only a real hang-up on a live call will tell you whether it works.';

async function probeCarriers(cfg: VoiceLineConfig): Promise<CarrierProbe[]> {
  // Only the carriers with an adapter are probed. The rest have nothing to
  // prove — `carrierReadiness` already reports, by name, that they cannot hang
  // up at all — and probing them would imply a route that is not there.
  const probes: CarrierProbe[] = [];
  for (const kind of HANGUP_CARRIERS) {
    const carrier = carrierFor(kind, cfg);
    if (carrier.unavailable) {
      probes.push({ kind, status: 'not-configured', probe: null, detail: carrier.unavailable });
      continue;
    }
    if (!carrier.check) {
      probes.push({ kind, status: 'no-probe', probe: null, detail: NO_PROBE });
      continue;
    }
    const result = await carrier.check();
    probes.push({
      kind,
      status: result.ok ? 'pass' : 'fail',
      probe: result.probe,
      detail: result.detail,
    });
  }
  return probes;
}

// ------------------------------------------------------------------- commands

const listCommand: CommandSpec = {
  name: 'list',
  summary: 'List every phone line, its carrier, and the hang-up route that carrier gives.',
  usage: 'lines.ts list [--json]',
  async run(ctx: CommandContext) {
    const provider = await getProvider();
    const lines = await provider.listLines(); // also records carriers into config.json
    const routes = routeNotes(lines, readConfig());
    emit(ctx, { lines, routes }, (d) => {
      if (d.lines.length === 0) {
        console.log(
          'No phone lines on this account.\n' +
            'Numbers are imported by the user in the ElevenLabs dashboard ' +
            '(Phone Numbers → label, number, SID, token), never by this agent.\n' +
            'See references/set-up-the-line.md.',
        );
        return;
      }
      console.log(
        table(
          ['ID', 'NUMBER', 'LABEL', 'CARRIER', 'ANSWERED BY'],
          d.lines.map((l) => [
            l.id,
            l.number,
            l.label || '—',
            l.carrier,
            l.answeredBy ? `${l.answeredBy.name} (${l.answeredBy.id})` : 'nobody assigned',
          ]),
        ),
      );
      console.log('\nHang-up routes detected from the carriers above:');
      for (const r of d.routes) {
        console.log(`\n  ${r.carrier}  (${r.lines} line${r.lines === 1 ? '' : 's'})`);
        console.log(`    route:  ${r.route}`);
        console.log(`    needs:  ${r.needs}`);
        console.log(
          `    status: ${
            r.unavailable
              ? `hang-up NOT available — ${r.unavailable}`
              : r.configured
                ? 'configured — hang-up should work once the vault entry is in place'
                : 'not configured yet'
          }`,
        );
      }
      console.log(`\n${OPTIONAL_NOTE}`);
    });
  },
};

const assignCommand: CommandSpec = {
  name: 'assign',
  summary: 'Set which persona answers a line (or clear it with --none).',
  usage: 'lines.ts assign <lineId> <personaId> | lines.ts assign <lineId> --none [--json]',
  async run(ctx: CommandContext) {
    refuseCredentialFlags(ctx);
    const [lineId, personaId] = ctx.args.positionals;
    const clear = flagBool(ctx.args, 'none', false);
    if (!lineId) {
      throw new VoiceToolError(
        'assign needs a line id: lines.ts assign <lineId> <personaId> | <lineId> --none',
        { code: 'usage', exitCode: ExitCode.USAGE },
      );
    }
    if (!clear && !personaId) {
      throw new VoiceToolError(
        'assign needs a persona id, or --none to leave the line unanswered. ' +
          'Run personas.ts list to see the ids.',
        { code: 'usage', exitCode: ExitCode.USAGE },
      );
    }
    if (clear && personaId) {
      throw new VoiceToolError('--none takes no persona id.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
      });
    }
    const provider = await getProvider();
    const line = await provider.assignLine(lineId, clear ? null : personaId!);
    emit(ctx, { line }, (d) => {
      console.log(
        d.line.answeredBy
          ? `${d.line.number} (${d.line.label || d.line.id}) is now answered by ` +
              `${d.line.answeredBy.name} (${d.line.answeredBy.id}).`
          : `${d.line.number} (${d.line.label || d.line.id}) now has no persona assigned — ` +
              'inbound calls to it will not be answered.',
      );
      console.log(
        'Check the persona has the `end_call` system tool before it takes real calls ' +
          '(personas.ts show ' +
          (d.line.answeredBy?.id ?? '<personaId>') +
          '); without it the persona runs until the callee hangs up.',
      );
    });
  },
};

/**
 * Flags that configured the Exotel and SIP hang-up adapters before those were
 * removed. They are refused by name rather than ignored: silently accepting one
 * and writing nothing looks identical to success, and the person typing it is
 * working from an old transcript or an old doc and believes hang-up is now set
 * up. Delete these entries if either adapter comes back.
 */
const RETIRED_FLAGS: Record<string, string> = {
  'exotel-sid': 'Exotel',
  'exotel-subdomain': 'Exotel',
  'sip-vendor': 'SIP trunk',
  'sip-hangup-url': 'SIP trunk',
  'sip-method': 'SIP trunk',
  'sip-id-field': 'SIP trunk',
};

function refuseRetiredFlags(ctx: CommandContext): void {
  const used = Object.keys(ctx.args.flags).filter((k) => k in RETIRED_FLAGS);
  if (used.length === 0) return;
  const carriers = [...new Set(used.map((k) => RETIRED_FLAGS[k]!))];
  throw new VoiceToolError(
    `--${used.join(', --')}: this template no longer has ${carriers.join(' or ')} hang-up, so ` +
      'there is nothing for these to configure and NOTHING WAS WRITTEN. Neither adapter was ever ' +
      'confirmed against a live account, so both were removed rather than left to fail silently ' +
      `mid-call. Twilio is the only carrier that can end a call in flight here. On a ${carriers.join('/')} ` +
      'line the route to offer is the `end_call` system tool on the persona, which works on every ' +
      'carrier and every plan.',
    {
      code: 'carrier_not_supported',
      exitCode: ExitCode.UNSUPPORTED,
      hint: 'skills/voice-line/references/ending-a-call.md',
    },
  );
}

/**
 * The identifier half of carrier setup. The credential half never comes through
 * here: an Account SID is an identifier, and the key that goes with it lives
 * only in the OneCLI vault, keyed by the carrier's host. `refuseCredentialFlags`
 * rejects any flag that looks like the other half, and `writeConfig` refuses a
 * credential-shaped key a second time.
 *
 * Twilio is the only carrier with flags here, because it is the only one with a
 * hang-up adapter. An Exotel or SIP line has nothing to record — `list` reports
 * it, and `carrierReadiness` says by name why hang-up is unavailable on it.
 */
const carrierCommand: CommandSpec = {
  name: 'carrier',
  summary:
    "Record Twilio's Account SID so hang-up has a route, and with --check prove its vault " +
    'credential works (no credential passes through here).',
  usage: 'lines.ts carrier [--twilio-sid <AccountSid>] [--check] [--json]',
  async run(ctx: CommandContext) {
    refuseCredentialFlags(ctx);
    refuseRetiredFlags(ctx);

    const check = flagBool(ctx.args, 'check', false);
    const twilioSid = flag(ctx.args, 'twilio-sid');

    const patch: Partial<VoiceLineConfig> = {};
    if (twilioSid) patch.twilio = { accountSid: twilioSid };

    const config = Object.keys(patch).length > 0 ? writeConfig(patch) : readConfig();
    const readiness = carrierReadiness(config);
    const wrote = Object.keys(patch);
    // Written first, then probed: --check should report the entry that is now on
    // disk, not the one that was there when the command started.
    const probes = check ? await probeCarriers(config) : null;

    emit(ctx, { wrote, twilio: config.twilio ?? null, readiness, probes }, (d) => {
      if (d.wrote.length === 0) {
        console.log('Nothing given, so nothing was written. Current carrier configuration:');
      } else {
        console.log(`Recorded identifiers for: ${d.wrote.join(', ')}.`);
      }
      console.log(`  twilio: ${d.twilio ? `accountSid ${d.twilio.accountSid}` : 'not configured'}`);
      console.log('\nHang-up readiness per carrier:');
      for (const entry of d.readiness) {
        console.log(`  ${entry.kind}: ${entry.reason ? `not available — ${entry.reason}` : 'ready'}`);
      }
      if (d.probes) {
        // The verdict first, in one line. A probe block skimmed from the top
        // must not be able to read as "fine" when a carrier failed — that is
        // the whole reason this flag exists.
        const failed = d.probes.filter((p) => p.status === 'fail').map((p) => p.kind);
        const passed = d.probes.filter((p) => p.status === 'pass').map((p) => p.kind);
        console.log(
          `\nVERDICT: ${
            failed.length > 0
              ? `${failed.join(', ')} FAILED the credential probe — hang-up will not work on ` +
                `${failed.length === 1 ? 'that carrier' : 'those carriers'} until it is fixed.`
              : passed.length > 0
                ? `${passed.join(', ')} passed the credential probe.`
                : 'nothing was probed — no carrier here has both its identifiers recorded and a read-only probe.'
          }`,
        );
        console.log('\nCredential probe (read-only — nothing was hung up):');
        for (const p of d.probes) {
          console.log(`  ${p.kind}: ${p.status}`);
          if (p.probe) console.log(`    sent:   ${p.probe}`);
          console.log(`    detail: ${p.detail}`);
        }
      } else {
        console.log(
          '\nThis says the identifiers are recorded, NOT that the vault credential works.\n' +
            'Re-run with --check to prove that with a read-only request, before a live call does.',
        );
      }
      console.log(
        '\nNo credential was written and none should be: the matching key goes in the OneCLI\n' +
          'vault on the host, keyed by that carrier\'s API host. See references/connect-provider.md.',
      );
      console.log(`\n${OPTIONAL_NOTE}`);
    });
  },
};

const spec: ToolSpec = {
  tool: 'lines.ts',
  summary:
    'Phone lines: survey them (which also detects each line\'s carrier and hang-up route), choose which persona answers, and record the carrier identifiers hang-up needs.',
  commands: [listCommand, assignCommand, carrierCommand],
};

await runTool(spec, Bun.argv.slice(2));
