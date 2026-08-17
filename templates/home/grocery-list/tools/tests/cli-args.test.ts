/**
 * Argument parsing, and the one accident it must never absorb.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * WHAT IS BEING PROTECTED
 * -----------------------
 * A name is one argument and a shell does not know that. `add --name קוקה קולה`
 * — unquoted — hands `--name` the first word and leaves the rest in
 * `positionals`. Both halves look legitimate, so nothing in the parser can flag
 * it; the old `flag(...) ?? positionals.join(' ')` simply discarded the
 * remainder.
 *
 * That is not a cosmetic loss. It happened in production on 2026-08-16: the
 * product was created as `קוקה`, a confirmation answered against it taught that
 * half-name as a PERMANENT alias, and bare `קוקה` then resolved to plain Coke
 * forever — silently, with no question, next to an existing `קוקה קולה זירו`
 * that it is equally a prefix of. An alias is the one thing this CLI writes that
 * nothing later re-derives, so a half-name reaching it is unrecoverable without
 * an operator.
 *
 * Hence: a flag value AND leftover positionals together are a usage error that
 * names both halves. Never a guess, never a silent join. Same rule for the bare
 * positional form these verbs also accept — that form is not the bug and keeps
 * working.
 *
 * These are pure-function tests: lib/cli.ts imports only lib/errors.ts, so
 * nothing here opens a database and no `MARKET_HOME` isolation is needed.
 */
import { expect, test } from 'bun:test';

import { noStrayPositionals, parseArgv, textArg } from '../lib/cli.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';

const ADD = { verb: 'add', usage: 'grocery.ts add --name <text>', flags: ['name'] };
const PROBE = {
  verb: 'categories --probe',
  usage: 'grocery.ts categories [--probe] [--name <product name>]',
  flags: ['name', 'probe'],
};

/** What the shell really hands the tool when a name with a space is unquoted. */
const unquoted = (...argv: string[]) => parseArgv(argv);

/* --------------------------------------------- the accident is refused loudly */

test('an unquoted --name is a usage error naming both halves, not a half-name', () => {
  const args = unquoted('add', '--name', 'קוקה', 'קולה');
  expect(args.flags.name).toBe('קוקה');
  expect(args.positionals).toEqual(['קולה']);

  let caught: unknown;
  try {
    textArg(args, ADD);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(GroceryError);
  const error = caught as GroceryError;
  expect(error.code).toBe('usage');
  expect(error.exitCode).toBe(ExitCode.USAGE);
  // Both halves must appear, or the operator cannot see what was lost.
  expect(error.message).toContain('קוקה');
  expect(error.message).toContain('קולה');
  // The hint has to be copy-pasteable: the whole name, quoted.
  expect(error.hint).toContain('"קוקה קולה"');
  expect(error.hint).toContain('Nothing was written');
});

test('three or more leftover words are all reported', () => {
  const args = unquoted('add', '--name', 'cottage', 'cheese', 'light');
  expect(() => textArg(args, ADD)).toThrow(/"cheese", "light"/);
  expect(() => textArg(args, ADD)).toThrow(/not quoted/);
});

test('the error names the flag that was actually typed, not the first one declared', () => {
  // `--probe` takes a value on purpose, so it suffers the same accident.
  const args = unquoted('categories', '--probe', 'cottage', 'cheese');
  expect(() => textArg(args, PROBE)).toThrow(/--probe got "cottage"/);
});

/* ------------------------------------------- every legitimate form still works */

test('a quoted flag value is returned untouched', () => {
  expect(textArg(unquoted('add', '--name', 'קוקה קולה'), ADD)).toBe('קוקה קולה');
  expect(textArg(unquoted('add', '--name', 'milk'), ADD)).toBe('milk');
});

test('the bare positional form is not the bug and keeps working', () => {
  expect(textArg(unquoted('add', 'milk'), ADD)).toBe('milk');
  // Multiple positionals with no flag are the documented spelling, joined.
  expect(textArg(unquoted('add', 'cottage', 'cheese'), ADD)).toBe('cottage cheese');
});

test('--name= keeps its spaces, since the shell never split it', () => {
  expect(textArg(unquoted('add', '--name=קוקה קולה'), ADD)).toBe('קוקה קולה');
});

test('a nameless --probe stays empty so the caller can apply its default', () => {
  // A bare switch carries no string, so it is skipped rather than reported.
  expect(textArg(unquoted('categories', '--probe'), PROBE)).toBe('');
  expect(textArg(unquoted('categories', '--probe', '--json'), PROBE)).toBe('');
});

test('nothing to resolve is empty, not an error — the verb owns that message', () => {
  expect(textArg(unquoted('add'), ADD)).toBe('');
});

test('surrounding whitespace is trimmed from either spelling', () => {
  expect(textArg(unquoted('add', '--name', '  milk  '), ADD)).toBe('milk');
  expect(textArg(unquoted('add', '  milk  '), ADD)).toBe('milk');
});

/* ---------------------------------- subcommand verbs: the same rule, past them */

test('a subcommand verb accepts exactly the positionals it declares', () => {
  const spec = (consumed: number) => ({ verb: 'products', usage: 'grocery.ts products …', consumed });

  // `products rename --id 5` — one positional, which the verb owns.
  expect(() => noStrayPositionals(unquoted('products', 'rename'), spec(1))).not.toThrow();
  // `products alias add` — two, both owned.
  expect(() => noStrayPositionals(unquoted('products', 'alias', 'add'), spec(2))).not.toThrow();
  // The default `products` with no subcommand at all.
  expect(() => noStrayPositionals(unquoted('products'), spec(1))).not.toThrow();
});

test('a word past the declared subcommands is the same accident, refused', () => {
  // `products rename --id 5 --name קוקה קולה` would otherwise rename to `קוקה`.
  const args = unquoted('products', 'rename', '--id', '5', '--name', 'קוקה', 'קולה');
  expect(args.flags.name).toBe('קוקה');
  expect(args.positionals).toEqual(['rename', 'קולה']);

  let caught: unknown;
  try {
    noStrayPositionals(args, { verb: 'products rename', usage: 'grocery.ts products …', consumed: 1 });
  } catch (error) {
    caught = error;
  }
  const error = caught as GroceryError;
  expect(error).toBeInstanceOf(GroceryError);
  expect(error.code).toBe('usage');
  expect(error.exitCode).toBe(ExitCode.USAGE);
  expect(error.message).toContain('"קולה"');
  // `rename` is owned, so it must NOT be reported as stray.
  expect(error.message).not.toContain('rename"');
});

/* ------------------------------------------- parser behaviour these rules rest on */

test('a declared boolean flag never swallows the positional after it', () => {
  // The regression this list exists for: `add --json milk` must keep both.
  const args = unquoted('add', '--json', 'milk');
  expect(args.json).toBe(true);
  expect(textArg(args, ADD)).toBe('milk');
});

test('everything after -- is a positional, however it is spelled', () => {
  const args = unquoted('add', '--', '--name');
  expect(args.positionals).toEqual(['--name']);
  expect(textArg(args, ADD)).toBe('--name');
});
