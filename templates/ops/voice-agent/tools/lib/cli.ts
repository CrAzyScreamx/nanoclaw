// ============================================================================
// lib/cli.ts — subcommand + flag parsing, --json, help, exit codes.
//
// Every tool in this template is `bun tools/<name>.ts <command> [flags]`.
// `--help` is answered before any provider is constructed, so help never
// touches the network.
//
// Exit codes: 0 ok, 1 unexpected, 2 usage, 3 auth, 4 unsupported,
//             5 not found, 6 ambiguous, 7 upstream.
// ============================================================================

import {
  ExitCode,
  HttpError,
  VoiceToolError,
} from './provider.ts';

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  help: boolean;
  /** Every occurrence of a repeated flag, in order. Populated by parseArgv. */
  repeats?: Record<string, string[]>;
}

function isValue(token: string | undefined): boolean {
  if (token === undefined) return false;
  if (!token.startsWith('-')) return true;
  return /^-\d/.test(token);   // negative numbers are values, not flags
}

/**
 * Flags that never take a value. Without this list a boolean flag swallows the
 * positional after it — `calls.ts show --json <id>` would lose the id AND turn
 * JSON mode off — so every switch used by any tool in this template is declared
 * here. `--flag=true` still works for all of them.
 */
const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'yes', 'live', 'transcript', 'dry-run', 'none',
  'end-call-tool', 'all', 'verbose', 'check',
]);

/** `--k v`, `--k=v`, `--bool`, `--no-bool`, `-h`, `--help`; `--` ends parsing. */
export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const repeats: Record<string, string[]> = {};
  const rest: string[] = [];
  let literal = false;

  const set = (name: string, value: string | boolean): void => {
    flags[name] = value;
    if (typeof value === 'string') {
      (repeats[name] ??= []).push(value);
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (literal) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (token === '-h') {
      set('help', true);
      continue;
    }
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        set(raw.slice(0, eq), raw.slice(eq + 1));
        continue;
      }
      if (raw.startsWith('no-')) {
        set(raw.slice(3), false);
        continue;
      }
      if (!BOOLEAN_FLAGS.has(raw) && isValue(argv[i + 1])) {
        set(raw, argv[i + 1]!);
        i++;
        continue;
      }
      set(raw, true);
      continue;
    }
    rest.push(token);
  }

  const command = rest.length > 0 ? rest[0]! : null;
  return {
    command,
    positionals: rest.slice(1),
    flags,
    json: truthy(flags.json),
    help: truthy(flags.help),
    repeats,
  };
}

/** Present-and-not-negated. Any value other than an explicit falsehood counts. */
function truthy(value: string | boolean | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'n', 'off', ''].includes(value.trim().toLowerCase());
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalised = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalised)) return true;
  if (['false', '0', 'no', 'n', 'off', ''].includes(normalised)) return false;
  return true;
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.trim() === '') {
    throw new VoiceToolError(`Missing required flag --${name}.`, {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: `Run the tool with --help to see the full usage.`,
    });
  }
  return value;
}

/** Every occurrence of a repeatable flag, e.g. `--var name=Ada --var city=London`. */
export function multiFlag(args: ParsedArgs, name: string): string[] {
  const collected = args.repeats?.[name];
  if (collected && collected.length > 0) return collected;
  const single = flag(args, name);
  return single === undefined ? [] : [single];
}

/** `k=v` pairs from a repeated flag, for dynamic variables. */
export function keyValueFlag(args: ParsedArgs, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of multiFlag(args, name)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new VoiceToolError(`--${name} expects key=value, got "${entry}".`, {
        code: 'usage',
        exitCode: ExitCode.USAGE,
      });
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export interface CommandContext {
  args: ParsedArgs;
  json: boolean;
}

// ------------------------------------------------------------------ refusals

const REFUSED_FLAG =
  /(trunk|digest|user_?name|pass(word|wd)?|secret|token|credential|api[-_]?key|auth)/i;

/**
 * Refuses any flag that would carry a credential — or a SIP trunk config block —
 * into a request body. The vault rewrites HEADERS on outbound HTTPS, while trunk
 * digest username/password ride inside a JSON body to ElevenLabs, so they cannot
 * be vault-backed; anywhere else in the container means plaintext. They stay in
 * the ElevenLabs dashboard and this template never sees them.
 *
 * Shared by lines.ts and personas.ts so the two refusals cannot drift apart.
 */
export function refuseCredentialFlags(ctx: CommandContext): void {
  const bad = Object.keys(ctx.args.flags).filter((k) => REFUSED_FLAG.test(k));
  if (bad.length === 0) return;
  throw new VoiceToolError(
    `Refusing --${bad.join(', --')}: no credential passes through this agent. ` +
      'Every key lives in the OneCLI vault on the host, where the gateway injects it ' +
      'by destination host — a token typed into a command here would be in the shell ' +
      'history, the transcript and possibly a file. ' +
      'SIP trunk configuration and digest username/password are a second case with a ' +
      'structural reason: the vault rewrites headers on outbound HTTPS, while those ' +
      'values ride inside a JSON body to ElevenLabs, so they cannot be vault-backed ' +
      'at all — they are set by the user in the ElevenLabs dashboard.',
    {
      code: 'refused_credential_input',
      exitCode: ExitCode.USAGE,
      hint: 'skills/voice-line/references/set-up-the-line.md',
    },
  );
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CommandContext): Promise<void>;
}

export interface ToolSpec {
  tool: string;          // e.g. "lines.ts"
  summary: string;
  commands: CommandSpec[];
}

// ------------------------------------------------------------------- output

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Plain aligned text, no colour. Header row plus body rows. */
export function formatTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, col) =>
    all.reduce((max, row) => Math.max(max, (row[col] ?? '').length), 0),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, col) => (col === row.length - 1 ? (cell ?? '') : (cell ?? '').padEnd(widths[col]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function helpText(spec: ToolSpec, command?: CommandSpec): string {
  if (command) {
    return [
      `${spec.tool} ${command.name} — ${command.summary}`,
      '',
      `Usage: ${command.usage}`,
      '',
      'Global flags:',
      '  --json      machine-readable output: {"ok":true,"data":…}',
      '  --help, -h  this help',
    ].join('\n');
  }
  const names = spec.commands.map((c) => c.name);
  const width = names.reduce((max, n) => Math.max(max, n.length), 0);
  const lines = [
    `${spec.tool} — ${spec.summary}`,
    '',
    `Usage: bun ${spec.tool} <command> [flags]`,
    '',
    'Commands:',
    ...spec.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Command usage:',
    ...spec.commands.map((c) => `  ${c.usage}`),
    '',
    'Global flags:',
    '  --json      machine-readable output: {"ok":true,"data":…}',
    '  --help, -h  this help',
  ];
  return lines.join('\n');
}

export function printHelp(spec: ToolSpec, command?: CommandSpec): void {
  out(helpText(spec, command));
}

/**
 * --json  -> stdout gets exactly one object: {"ok":true,"data":<data>}
 * else    -> human(data) writes plain text to stdout.
 */
export function emit<T>(ctx: CommandContext, data: T, human: (data: T) => void): void {
  if (ctx.json) {
    out(JSON.stringify({ ok: true, data }));
    return;
  }
  human(data);
}

interface ErrorShape {
  code: string;
  message: string;
  hint?: string;
  status?: number;
}

function describe(error: unknown): { shape: ErrorShape; exitCode: number } {
  if (error instanceof VoiceToolError) {
    const shape: ErrorShape = { code: error.code, message: error.message };
    if (error.hint) shape.hint = error.hint;
    if (error instanceof HttpError) shape.status = error.status;
    return { shape, exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { shape: { code: 'unexpected', message }, exitCode: ExitCode.UNEXPECTED };
}

function report(ctx: CommandContext, error: unknown): number {
  const { shape, exitCode } = describe(error);
  if (ctx.json) {
    out(JSON.stringify({ ok: false, error: shape }));
  } else {
    err(shape.message);
    if (shape.hint) err(shape.hint);
  }
  return exitCode;
}

/**
 * Parses, dispatches, catches everything, prints and exits. `--help` is handled
 * before any provider is constructed, so `bun tools/<x>.ts --help` never hits
 * the network.
 */
export async function runTool(spec: ToolSpec, argv: string[]): Promise<never> {
  const args = parseArgv(argv);
  const ctx: CommandContext = { args, json: args.json };

  // Usage failures go through report() too, so --json always yields exactly one
  // object on stdout. The help text stays on stderr for the human path.
  // Explicitly typed so TS treats the call sites below as never-returning.
  const usageExit: (message: string) => never = (message) => {
    err(helpText(spec));
    err('');
    process.exit(report(ctx, new VoiceToolError(message, {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: `Run \`bun ${spec.tool} --help\` for the command list.`,
    })));
  };

  if (args.command === null || args.command === 'help') {
    if (args.help || args.command === 'help') {
      printHelp(spec);
      process.exit(ExitCode.OK);
    }
    usageExit('No command given.');
  }

  const command = spec.commands.find((c) => c.name === args.command);
  if (!command) {
    usageExit(`Unknown command "${args.command}".`);
  }

  if (args.help) {
    printHelp(spec, command);
    process.exit(ExitCode.OK);
  }

  try {
    await command.run(ctx);
  } catch (error) {
    process.exit(report(ctx, error));
  }
  process.exit(ExitCode.OK);
}
