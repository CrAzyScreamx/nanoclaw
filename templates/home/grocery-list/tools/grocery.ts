#!/usr/bin/env bun
/**
 * The grocery list, as a small verb-oriented CLI over one SQLite file.
 *
 * The agent calls these verbs instead of editing state by hand — a constrained
 * surface is far more reliable than free-form file edits, especially on a small
 * model. Every verb that produces something a person will read renders it here,
 * so the agent forwards a finished line rather than assembling one.
 *
 * This file is the entry point and nothing else: collect the verbs, make sure
 * the database has the shape they assume, and hand argv to `runTool`, which
 * supplies `--help`, `--json` (`{"ok":true,"data":…}`) and the exit codes in
 * lib/errors.ts.
 *
 * `lib/` splits by concern — db, bootstrap (all the DDL), cli, locale, time,
 * weeks, categories, products, product-match, classify, purchases, render,
 * sheets, printable — and each file's own header says what it owns. The verbs
 * are grouped in `commands/` by the state they touch; the list below is the
 * authority on which verb lives where.
 */
import { addCommand } from './commands/add.ts';
import { categoriesCommand, recategoriseCommand } from './commands/categories.ts';
import { configCommand } from './commands/config.ts';
import { markBoughtCommand, removeCommand, unmarkCommand } from './commands/edit.ts';
import { printCommand, printableCommand } from './commands/print.ts';
import { productsCommand } from './commands/products.ts';
import { reportCommand } from './commands/report.ts';
import { preRotateCommand, rotateCommand } from './commands/rotate.ts';
import { findCommand, listCommand, messageCommand, weeksCommand } from './commands/views.ts';
import { bootstrap } from './lib/bootstrap.ts';
import type { CommandSpec, ToolSpec } from './lib/cli.ts';
import { runTool } from './lib/cli.ts';

/**
 * The two verbs the weekly tasks drive, and the only two that run `bootstrap`
 * with the classifier sweep switched off — both run on a clock with a chat
 * announcement waiting behind them, and a model call in front of either is a
 * stall the announcement pays for. See lib/bootstrap.ts's BootstrapOptions.sweep.
 */
const NO_SWEEP = new Set(['pre-rotate', 'rotate']);

/**
 * `bootstrap()` runs at dispatch, not at import, so `--help` and a mistyped verb
 * never create the database. It still runs exactly once per invocation:
 * `runTool` dispatches a single command.
 */
let ready = false;
function withBootstrap(command: CommandSpec): CommandSpec {
  return {
    ...command,
    async run(ctx) {
      if (!ready) {
        bootstrap({ sweep: !NO_SWEEP.has(command.name) });
        ready = true;
      }
      await command.run(ctx);
    },
  };
}

const spec: ToolSpec = {
  tool: 'grocery.ts',
  summary: 'the shopping list: add, show, mark off, roll the week over, print',
  commands: [
    addCommand,
    listCommand,
    messageCommand,
    findCommand,
    weeksCommand,
    markBoughtCommand,
    removeCommand,
    unmarkCommand,
    reportCommand,
    preRotateCommand,
    rotateCommand,
    printableCommand,
    printCommand,
    productsCommand,
    categoriesCommand,
    recategoriseCommand,
    configCommand,
  ].map(withBootstrap),
};

await runTool(spec, Bun.argv.slice(2));
