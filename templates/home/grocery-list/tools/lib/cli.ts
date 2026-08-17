// ============================================================================
// lib/cli.ts — subcommand + flag parsing, --json, help, exit codes.
//
// `bun tools/<name>.ts <command> [flags]`, `--help` answered before anything
// else runs, `--json` producing exactly one object on stdout, and the numeric
// exit codes in lib/errors.ts. Help text is derived from the CommandSpecs
// themselves, so a verb cannot exist without being documented.
// ============================================================================

import { ExitCode, GroceryError } from './errors.ts';

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  help: boolean;
}

function isValue(token: string | undefined): boolean {
  if (token === undefined) return false;
  if (!token.startsWith('-')) return true;
  return /^-\d/.test(token);   // negative numbers are values, not flags
}

/**
 * Flags that never take a value. Without this list a boolean flag swallows the
 * positional after it — `grocery.ts add --json milk` would lose the name AND
 * turn JSON mode off. `--flag=true` still works for all of them, and
 * `--no-flag` sets any flag false whether or not it is listed.
 *
 * Three switches are deliberately NOT listed, and all three would break if they
 * were:
 *
 *   --remember-corrections  commands/config.ts reads it as a tri-state — absent
 *                           means "leave the setting alone", so the value form
 *                           `--remember-corrections false` has to keep working.
 *   --probe                 commands/categories.ts accepts it as value-or-switch
 *                           on purpose: `--probe "cottage cheese"` names the
 *                           product to classify, and declaring it here would
 *                           turn that name back into a stray positional.
 *   --bought                a bare switch on `list --bought`, but left out so
 *                           that a stray `rotate --bought 47,51` parses as the
 *                           STRING "47,51" and commands/rotate.ts can reject it
 *                           by name, pointing at `--bought-n` or `--bought-id`.
 *                           Safe because `list --bought` is always followed by
 *                           another `-` flag or by nothing.
 *
 * The cost of forgetting one is silent: `products --apply-to-current-week
 * rename` would eat the `rename` positional and fall through to `list`.
 */
const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'yes', 'all', 'new-product', 'apply-to-current-week',
]);

/** `--k v`, `--k=v`, `--bool`, `--no-bool`, `-h`, `--help`; `--` ends parsing. */
export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let literal = false;

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
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      if (raw.startsWith('no-')) {
        flags[raw.slice(3)] = false;
        continue;
      }
      if (!BOOLEAN_FLAGS.has(raw) && isValue(argv[i + 1])) {
        flags[raw] = argv[i + 1]!;
        i++;
        continue;
      }
      flags[raw] = true;
      continue;
    }
    rest.push(token);
  }

  return {
    command: rest.length > 0 ? rest[0]! : null,
    positionals: rest.slice(1),
    flags,
    json: isTrue(flags.json),
    help: isTrue(flags.help),
  };
}

/** Present and not negated. Any value other than an explicit falsehood counts. */
function isTrue(value: string | boolean | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'n', 'off', ''].includes(value.trim().toLowerCase());
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/* ------------------------------------------------- the unquoted-name failure */

/**
 * A name is one argument, and a shell does not know that.
 *
 * `add --name קוקה קולה` — no quotes — gives `--name` the first word and leaves
 * every other word in `positionals`. Both halves look legitimate, so there is
 * nothing for the parser to notice: the flag has a plausible value, and the
 * leftovers look like the bare positional form these verbs also accept.
 * Resolving that with `flag(...) ?? positionals.join(' ')` therefore DISCARDED
 * the rest of the name in silence, and it did real damage — a product was
 * created as `קוקה`, a confirmation answered against it taught that half-name as
 * a permanent alias, and bare `קוקה` then resolved to plain Coke forever with no
 * question asked.
 *
 * Losing half a name quietly is the failure this whole CLI exists to prevent, so
 * the mixture is a usage error naming both halves. The precedent is `rotate`'s
 * `--bought` guard: a swallowed argument gets told what to type, never accepted
 * on a guess.
 */
function strayNameError(verb: string, flagName: string, given: string, stray: string[], usage: string): never {
  throw new GroceryError(
    `${verb}: --${flagName} got "${given}" and ${stray.map((s) => `"${s}"`).join(', ')} was left over` +
      ' — the name is not quoted.',
    {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: `A name with spaces needs quotes: --${flagName} "${given} ${stray.join(' ')}". Nothing was written.`,
      detail: usage,
    },
  );
}

/**
 * A text argument a verb accepts either as `--<flag> <text>` or as bare
 * positionals — and refuses as a mixture of the two, per `strayNameError`.
 *
 * `flags` is tried in order and the first one carrying a string wins, so the
 * error names the flag the caller actually typed (`categories --probe cottage
 * cheese` reports `--probe`, not `--name`). A flag parsed as a bare switch
 * carries no string and is skipped, which is what keeps a nameless
 * `categories --probe` working.
 */
export function textArg(args: ParsedArgs, spec: { verb: string; usage: string; flags: string[] }): string {
  for (const name of spec.flags) {
    const value = flag(args, name);
    if (value === undefined) continue;
    if (args.positionals.length > 0) strayNameError(spec.verb, name, value, args.positionals, spec.usage);
    return value.trim();
  }
  return args.positionals.join(' ').trim();
}

/**
 * Reject positionals a verb never declared.
 *
 * For a verb whose positionals are SUBCOMMANDS rather than free text
 * (`products alias add`), `consumed` is how many it owns; anything past that is
 * the same quoting accident arriving by another route — `products rename --id 5
 * --name קוקה קולה` would otherwise rename the product to `קוקה` and report
 * success.
 */
export function noStrayPositionals(
  args: ParsedArgs,
  spec: { verb: string; usage: string; consumed: number },
): void {
  const stray = args.positionals.slice(spec.consumed);
  if (stray.length === 0) return;
  throw new GroceryError(`${spec.verb}: unexpected ${stray.map((s) => `"${s}"`).join(', ')}.`, {
    code: 'usage',
    exitCode: ExitCode.USAGE,
    hint: 'A value with spaces needs quotes. Nothing was written.',
    detail: spec.usage,
  });
}

export function flagBool(args: ParsedArgs, name: string, fallback = false): boolean {
  return isTrue(args.flags[name], fallback);
}

/**
 * `--id 47,51` / `--n 2 3` / `--carry-n 2,4` → a list of numbers.
 *
 * A leading `#` is accepted because the working view prints ids that way and
 * that is what gets copied back.
 */
export function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.replace(/^#/, '').trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

export interface CommandContext {
  args: ParsedArgs;
  json: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CommandContext): Promise<void>;
}

export interface ToolSpec {
  tool: string;          // "grocery.ts"
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
  /** Operator diagnostic. Reaches --json only; see the note in report(). */
  detail?: string;
}

function describe(error: unknown): { shape: ErrorShape; exitCode: number } {
  if (error instanceof GroceryError) {
    const shape: ErrorShape = { code: error.code, message: error.message };
    if (error.hint) shape.hint = error.hint;
    if (error.detail) shape.detail = error.detail;
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
    // `detail` is deliberately NOT printed here. The skills tell the agent to
    // relay a failed `printable`'s stderr to the group as-is — that line is
    // already in their language — so anything else written to stderr gets
    // relayed with it. Diagnostics ride on --json instead.
    err(shape.message);
    if (shape.hint) err(shape.hint);
  }
  return exitCode;
}

/**
 * Parses, dispatches, catches everything, prints and exits. `--help` is handled
 * before any command runs, so `bun tools/grocery.ts --help` never touches the
 * database.
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
    process.exit(report(ctx, new GroceryError(message, {
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
