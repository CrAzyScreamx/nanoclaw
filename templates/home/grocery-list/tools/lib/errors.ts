// ============================================================================
// lib/errors.ts — the error type every verb throws and the exit codes it maps
// to.
//
// This file imports NOTHING, deliberately. It is the leaf of the dependency
// graph so `lib/cli.ts` can catch and describe these without importing any
// module that touches the database — `bun tools/grocery.ts --help` must answer
// without opening a file.
//
// EXIT CODES ARE A CONTRACT, NOT DECORATION
// -----------------------------------------
// The agent runs these verbs through Bash and reads the status. A verb that
// exits 3 says "the list is empty, there is nothing to print" — a normal thing
// to tell the group — while 1 says "something broke". Collapsing them into a
// single failure code is what turns "the list is empty" into an apology about
// an internal error.
//
//   0 ok · 1 unexpected · 2 usage · 3 auth/refusal · 4 unsupported
//   5 not found · 6 ambiguous (a human has to decide) · 7 upstream
// ============================================================================

export const ExitCode = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  /**
   * Nothing was done and a credential or a precondition is the reason. The
   * print path also uses it for "the list is empty — nothing to print".
   */
  AUTH: 3,
  UNSUPPORTED: 4,
  NOT_FOUND: 5,
  /**
   * "I did nothing, and you have to decide something." Two distinct `code`s
   * share it: `ambiguous_target` (more than one candidate — pick one) and
   * `confirm_required` (a human has to say yes first, which is what `print`
   * without `--yes` raises). Read `code`, not just the exit status.
   */
  AMBIGUOUS: 6,
  UPSTREAM: 7,
} as const;

export class GroceryError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;
  readonly detail?: string;

  /**
   * `hint` and `detail` are NOT the same audience, and the split is load-bearing.
   *
   * `hint` is for the agent and prints on stderr under the message — "use
   * `--bought-n` instead" is exactly the sort of thing it must read. `detail` is
   * an operator diagnostic (a renderer's stack, an upstream body) and reaches
   * `--json` ONLY.
   *
   * The reason is the print path. The skills tell the agent to relay a failed
   * `printable`'s stderr to the group as-is, because that line is already
   * written in their language. A second, English line underneath it would be
   * relayed too. Keeping the diagnostic off stderr makes that leak structurally
   * impossible rather than something the agent has to remember not to do.
   */
  constructor(
    message: string,
    opts: { code: string; exitCode: number; hint?: string; detail?: string },
  ) {
    super(message);
    this.name = 'GroceryError';
    this.code = opts.code;
    this.exitCode = opts.exitCode;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}
