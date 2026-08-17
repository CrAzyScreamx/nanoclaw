/**
 * The two ways a list leaves this tool as a document: `printable` makes the
 * PDF, `print` puts it on paper.
 *
 * WHY `printable` IS ONE VERB
 * ---------------------------
 * Leaving the agent to categorise the items and hand-write the print JSON makes
 * the sheet's contents depend on a small model getting a data-shaping step right
 * every time — and the `note` qualifier ("5%", "250 g") is what gets dropped, so
 * the list says "ski cheese" where the shopper needs "ski cheese 250 g 5%".
 *
 * Contract, so the agent needs one rule rather than a procedure: **stdout is
 * the PDF path and nothing else.** An empty list and a hard failure both exit
 * non-zero with one line on stderr, in the group's language, ready to relay
 * as-is.
 *
 * WHY `print` RE-RENDERS INSTEAD OF TAKING A PATH
 * -----------------------------------------------
 * A `print --file <path>` verb would let the agent skip the render entirely and
 * print whatever sheet is lying around. Re-rendering costs a few seconds and
 * makes "print the list" mean the list as it is now, which is the only thing it
 * can usefully mean.
 *
 * WHY `print` REFUSES WITHOUT `--yes`
 * -----------------------------------
 * Paper is not undoable and the printer is in someone's home. Without `--yes`
 * this verb renders, resolves the queue, names the queue and the page count,
 * and then exits without printing, so the agent has to come back with an
 * explicit yes. One approval covers one job; the tool remembers no previous yes.
 */
import { groupByCategory, listCategories } from '../lib/categories.ts';
import { emit, flag, flagBool, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { loadPack, t, type LocalePack } from '../lib/locale.ts';
import { countPdfPages, renderSheet, type SheetList } from '../lib/printable.ts';
import { qtyText } from '../lib/render.ts';
import { newSheetPath } from '../lib/sheets.ts';
import { sheetDate } from '../lib/time.ts';
import { pendingInWeek, resolveWeek } from '../lib/weeks.ts';

import { spawnSync } from 'node:child_process';

/**
 * Where cupsd is. `host.docker.internal:631` is the host's CUPS as seen from
 * inside the container — cupsd does not listen on this container's own
 * localhost, so the host has to be named on every call. `CUPS_SERVER` is the
 * standard override and is honoured here for an install that puts it elsewhere.
 */
const CUPS_HOST = process.env.CUPS_SERVER || 'host.docker.internal:631';

/**
 * Build the sheet payload for a week.
 *
 * Headings and their order come from the `categories` table, resolved through
 * `items → products → categories` — not from re-deciding the aisle at print
 * time, which with a model in the loop could sort the same list two different
 * ways on two consecutive prints.
 */
function buildSheet(ctx: CommandContext, pack: LocalePack): SheetList {
  const week = resolveWeek(flag(ctx.args, 'week'));
  const items = pendingInWeek(week);

  if (items.length === 0) {
    // Exit 3 rather than 1: "the list is empty" is a normal thing to tell the
    // group, and collapsing it into a generic failure turns it into an apology
    // about an internal error.
    throw new GroceryError(t(pack, 'listEmptyNothingToPrint'), {
      code: 'list_empty',
      exitCode: ExitCode.AUTH,
    });
  }

  // The aisle is resolved inside `groupByCategory`, through
  // `items → products → categories`. An item whose product has no category —
  // the classifier was unreachable when it was created — lands in the catch-all
  // rather than under no heading at all.
  const grouped = groupByCategory(items, listCategories());

  return {
    title: t(pack, 'sheetTitle'),
    date: sheetDate(),
    dir: pack.dir,
    lang: pack.tag,
    categories: grouped.map((aisle) => ({
      name: aisle.name,
      items: aisle.items.map((item) => ({
        name: item.name,
        // The same count-and-unit rule the chat lines use, without the
        // parentheses: the sheet gives it a column of its own. `note` goes
        // through untouched — it is the qualifier that says WHICH product to
        // buy, and it is the reason this verb exists.
        qty: qtyText(item.quantity, item.unit),
        note: item.note?.trim() || '',
      })),
    })),
  };
}

export const printableCommand: CommandSpec = {
  name: 'printable',
  summary: "Render this week's list as an A4 PDF. stdout is the file path and nothing else.",
  usage: 'grocery.ts printable [--week current|last|<id>] [--out <file.pdf>] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const payload = buildSheet(ctx, pack);

    // `--json` stops here: the sorted payload WITHOUT the render, for checking
    // how a list will be laid out without producing a file. It deliberately
    // leaves nothing on disk to be sent by mistake.
    if (ctx.json) {
      emit(ctx, payload, () => {});
      return;
    }

    const outPath = flag(ctx.args, 'out') || newSheetPath(payload.date, pack);
    const result = renderSheet(payload, outPath, pack);
    // Diagnostics on stderr so stdout stays exactly one path.
    process.stderr.write(
      `${result.items} items in ${result.categories} categories → ${result.bytes} bytes\n`,
    );
    console.log(result.path);
  },
};

/** What `lpstat -p -d` says about this host: the queues, and the default one. */
interface Queues {
  printers: string[];
  fallback: string | null;
}

/**
 * Ask cupsd what it has.
 *
 * `lp: command not found` is thrown as its own error because the fix is
 * completely different from every other failure here — the package is missing
 * from this container, which an operator has to grant.
 */
function listQueues(pack: LocalePack): Queues {
  const res = spawnSync('lpstat', ['-h', CUPS_HOST, '-p', '-d'], { encoding: 'utf8', timeout: 15_000 });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new GroceryError(t(pack, 'lpMissing'), {
      code: 'lp_missing',
      exitCode: ExitCode.UNSUPPORTED,
      hint:
        'cups-client is not installed in this container. In chat, install_packages({apt:["cups-client"]}) ' +
        'raises an admin approval and rebuilds on approve; on the host it is ' +
        '`ncl groups config add-package --id <group> --apt cups-client` followed by ' +
        '`ncl groups restart --id <group> --rebuild`. Paper printing also needs host CUPS — see SETUP.md.',
    });
  }
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const printers = [...text.matchAll(/^printer\s+(\S+)/gm)].map((m) => m[1]!);
  const fallback = text.match(/system default destination:\s*(\S+)/)?.[1] ?? null;
  return { printers, fallback };
}

/**
 * The queue this job goes to: `--queue` if given, then the system default, then
 * the only queue there is.
 *
 * Refuses rather than guessing when there is more than one queue and no
 * default — "which printer" is a question for a person, and picking one at
 * random prints in the wrong room.
 */
function resolveQueue(pack: LocalePack, asked: string | undefined): string {
  const { printers, fallback } = listQueues(pack);

  if (asked) {
    if (printers.length > 0 && !printers.includes(asked)) {
      throw new GroceryError(t(pack, 'printQueueMissing'), {
        code: 'queue_not_found',
        exitCode: ExitCode.NOT_FOUND,
        hint: `This host has: ${printers.join(', ') || '(no queues at all)'}.`,
      });
    }
    return asked;
  }
  if (fallback) return fallback;
  if (printers.length === 1) return printers[0]!;
  if (printers.length === 0) {
    throw new GroceryError(t(pack, 'printQueueMissing'), {
      code: 'no_queue',
      exitCode: ExitCode.AUTH,
      hint: `cupsd at ${CUPS_HOST} lists no queues. Printing is set up on the host — see SETUP.md.`,
    });
  }
  throw new GroceryError(t(pack, 'printQueueMissing'), {
    code: 'ambiguous_target',
    exitCode: ExitCode.AMBIGUOUS,
    hint: `More than one queue and no default: ${printers.join(', ')}. Ask which, then pass --queue.`,
  });
}

export const printCommand: CommandSpec = {
  name: 'print',
  summary: "Put this week's list on PAPER. Renders, names the queue and page count, and refuses without --yes.",
  usage: 'grocery.ts print [--week current|last|<id>] [--queue <name>] [--copies <n>] [--yes] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const copiesRaw = flag(ctx.args, 'copies');
    const copies = copiesRaw === undefined ? 1 : Number(copiesRaw);
    if (!Number.isInteger(copies) || copies < 1 || copies > 20) {
      throw new GroceryError('--copies must be a whole number between 1 and 20.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
      });
    }

    // Order matters. The payload comes first because an empty list is the most
    // ordinary refusal and costs nothing to find; the queue second, so a group
    // that never had printing set up is told so immediately instead of after a
    // ten-second render; the render last, and again on the confirming call —
    // see this file's header for why a path is never accepted.
    const payload = buildSheet(ctx, pack);
    const queue = resolveQueue(pack, flag(ctx.args, 'queue'));
    const sheet = renderSheet(payload, newSheetPath(payload.date, pack), pack);
    const pages = countPdfPages(sheet.path);

    if (!flagBool(ctx.args, 'yes', false)) {
      // NOTHING has been printed. The message names the queue and the page
      // count because those are the two things a person needs in order to say
      // yes to this rather than to printing in general.
      throw new GroceryError(t(pack, 'printConfirmRequired', { pages: pages ?? '?', queue }), {
        code: 'confirm_required',
        exitCode: ExitCode.AMBIGUOUS,
        hint:
          'Nothing has been printed. Send that line to the group as it is, and re-run with --yes ' +
          'only after someone says yes. One approval covers one job: a second copy needs a fresh yes.',
      });
    }

    const res = spawnSync(
      'lp',
      ['-h', CUPS_HOST, '-d', queue, '-n', String(copies), sheet.path],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Reachable even though `listQueues` ran first: `lpstat` and `lp` are
      // separate binaries and a half-installed client has one without the other.
      throw new GroceryError(t(pack, 'lpMissing'), { code: 'lp_missing', exitCode: ExitCode.UNSUPPORTED });
    }
    if (res.status !== 0) {
      throw new GroceryError(t(pack, 'printFailed'), {
        code: 'print_failed',
        exitCode: ExitCode.UPSTREAM,
        hint: (res.stderr || res.stdout || '').trim().slice(0, 400),
      });
    }

    // `lp` answers "request id is Office-42 (1 file(s))". The id is the only
    // handle anyone has on the job afterwards, so it is reported rather than
    // swallowed — and it is the honest limit of what is known: `lp` exiting 0
    // means cupsd ACCEPTED the job, not that anything reached paper.
    //
    // It is an OPERATOR's handle, though, and it stays out of the sentence the
    // group reads. Nobody in a family chat is going to type `lpstat`, and an id in
    // a confirmation reads like an error code. `--json` keeps it for whoever is
    // actually debugging a queue.
    const job = (res.stdout ?? '').match(/request id is (\S+)/)?.[1] ?? 'unknown';

    // `text` is the finished sentence, and it is in the JSON deliberately.
    //
    // Every other reply this CLI produces is rendered here and forwarded verbatim
    // — `add` hands back `confirm.line`, `message` hands back `text` — because an
    // assistant asked to compose instead drops a qualifier or a direction mark.
    // This verb used to render `printSubmitted` in the human branch ONLY, so an
    // assistant on `--json` received `{queue, job, …}` and no sentence, and did
    // exactly what that design exists to prevent: wrote its own. Observed in
    // production: `✓ שלחתי להדפסה: 1 עמודים לcode canon (job canon-13)` — mangled,
    // half in English, and carrying the id the pack leaves out on purpose.
    const text = t(pack, 'printSubmitted', { queue });
    emit(ctx, { text, queue, job, copies, pages, path: sheet.path }, (data) => console.log(data.text));
  },
};
