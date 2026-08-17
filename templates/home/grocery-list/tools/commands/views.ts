/**
 * The read-only verbs, and the line between them.
 *
 * `list` and `find` are the agent's WORKING views — `renderWorking` shapes them
 * so that pasting one into the group produces obvious garbage rather than a
 * plausible list. `message` is the opposite: its stdout IS the message, meant
 * to be forwarded verbatim.
 *
 * That split is the reason both exist. Retyping the group's message from `list`
 * output is where the direction marks get dropped, the "5%" note goes missing,
 * and the heading drifts into whatever phrasing was in recent conversation.
 */
import { foldForCompare } from '../lib/categories.ts';
import { db } from '../lib/db.ts';
import { emit, flag, flagBool, textArg, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { loadPack } from '../lib/locale.ts';
import { renderMessage, renderWorking } from '../lib/render.ts';
import type { ItemRow, WeekRow } from '../lib/types.ts';
import { currentWeek, firstAppearanceIds, pendingInWeek, resolveWeek } from '../lib/weeks.ts';

/**
 * Always scoped to a single week. Default: pending items in the current week —
 * last week's leftovers must never leak into a fresh list.
 */
export const listCommand: CommandSpec = {
  name: 'list',
  summary: 'Working view of one week — row ids, not list positions. Not for sending.',
  usage: 'grocery.ts list [--week current|last|<id>] [--all] [--bought] [--json]',
  async run(ctx: CommandContext) {
    const week = resolveWeek(flag(ctx.args, 'week'));
    if (!week) {
      emit(ctx, [] as ItemRow[], () => console.log(renderWorking([])));
      return;
    }
    const items = flagBool(ctx.args, 'all', false)
      ? (db()
          .query('SELECT * FROM items WHERE week_id = $week_id ORDER BY status, id')
          .all({ $week_id: week.id }) as ItemRow[])
      : (db()
          .query('SELECT * FROM items WHERE week_id = $week_id AND status = $status ORDER BY id')
          .all({
            $week_id: week.id,
            $status: flagBool(ctx.args, 'bought', false) ? 'bought' : 'pending',
          }) as ItemRow[]);
    emit(ctx, items, (data) => console.log(renderWorking(data)));
  },
};

/**
 * Substring match over pending items in the current week — used to map receipt
 * lines onto list entries before proposing them for `mark-bought`.
 *
 * Compared on the folded key rather than raw text, so case, spacing and
 * punctuation do not decide whether a receipt line finds its item.
 */
export const findCommand: CommandSpec = {
  name: 'find',
  summary: 'Find pending items whose name contains (or is contained by) some text.',
  usage: 'grocery.ts find --name <text> [--json]',
  async run(ctx: CommandContext) {
    const week = currentWeek();
    const query = textArg(ctx.args, {
      verb: 'find',
      usage: findCommand.usage,
      flags: ['name'],
    });
    if (!query) {
      throw new GroceryError('find: --name is required.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'grocery.ts find --name "milk"',
      });
    }
    const needle = foldForCompare(query);
    const hits = pendingInWeek(week).filter((item) => {
      const folded = foldForCompare(item.name);
      return folded.includes(needle) || needle.includes(folded);
    });
    emit(ctx, hits, (data) => console.log(renderWorking(data)));
  },
};

/**
 * The chat message for the list, rendered whole.
 *
 * Contract, deliberately identical in shape to `printable`: **stdout is the
 * message and nothing else.** Send it verbatim. An empty list is not an error
 * here — it renders as a one-line message and still exits 0, because "nothing
 * to buy" is an answer the group wants, unlike an empty sheet, which is not a
 * thing worth printing.
 */
export const messageCommand: CommandSpec = {
  name: 'message',
  summary: 'The list as one message, in the configured language. Send this verbatim.',
  usage: 'grocery.ts message [--week current|last|<id>] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const week = resolveWeek(flag(ctx.args, 'week'));
    const items = pendingInWeek(week);
    // The first time a product is ever listed is marked in the message itself, so
    // an invented product cannot reach the group looking like a regular. See the
    // note on `renderMessage`.
    const newProducts = firstAppearanceIds(items);
    const payload = {
      text: renderMessage(items, pack, newProducts),
      // The position→id map, so a caller that needs to act on a number the user
      // quoted has it without re-deriving the ordering. `n` is what the group
      // sees; `id` is what the receipt path passes to `--id`. The two number
      // spaces never line up, which is exactly why both are here.
      items: items.map((item, i) => ({
        n: i + 1,
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        note: item.note,
        // Mirrors the marker in `text`, so a --json caller sees the same fact
        // rather than having to parse it back out of a localised string.
        is_new_product: newProducts.has(item.id),
      })),
    };
    emit(ctx, payload, (data) => console.log(data.text));
  },
};

/** Week history with bought/total counts. */
export const weeksCommand: CommandSpec = {
  name: 'weeks',
  summary: 'Every week on file, newest first, with how much of each was bought.',
  usage: 'grocery.ts weeks [--json]',
  async run(ctx: CommandContext) {
    currentWeek();
    const rows = db().query('SELECT * FROM weeks ORDER BY week_start DESC').all() as WeekRow[];
    const withCounts = rows.map((week) => {
      const counts = db()
        .query(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'bought' THEN 1 ELSE 0 END) AS bought FROM items WHERE week_id = $week_id",
        )
        .get({ $week_id: week.id }) as { total: number; bought: number | null };
      return { ...week, total: counts.total, bought: counts.bought ?? 0 };
    });
    emit(ctx, withCounts, (data) => {
      for (const week of data) {
        console.log(`#${week.id} ${week.week_start} [${week.status}] — ${week.bought}/${week.total} bought`);
      }
    });
  },
};
