/**
 * The three verbs that change an item's fate: bought, un-bought, gone.
 *
 * All three take numbers, and which number space those numbers live in is the
 * one thing to get right.
 *
 * THE `--n` / `--id` SPLIT IS LOAD-BEARING
 * ----------------------------------------
 * `--n` is the POSITION the user read off the chat message; `--id` is the row
 * id, which only ever comes from `message --json` or `find`. The two number
 * spaces do not line up — positions restart at 1 every week and row ids never
 * repeat — so `--id 2` would silently act on an unrelated item or on nothing.
 *
 * `--n` resolves against a SNAPSHOT taken before any write, so `--n 2,3` marks
 * the second and third items of the list the user was looking at. The receipt
 * path uses `--id` for the opposite reason: anything added or removed between
 * the agent's question and the group's answer shifts every `n` under it, and
 * ids do not move.
 */
import { emit, flag, parseIds, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { db } from '../lib/db.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { loadPack } from '../lib/locale.ts';
import { renderMarked, renderWorking } from '../lib/render.ts';
import { now } from '../lib/time.ts';
import type { ItemRow } from '../lib/types.ts';
import { resolvePositions, resolveWeek } from '../lib/weeks.ts';

/**
 * Resolve `--n` (positions) or `--id` (row ids) to row ids.
 *
 * ONLY the `--n` path resolves a week. Going through `resolveWeek()` on an
 * `--id` call would trip the lazy rollover on a verb that never used to touch
 * the week at all — see the header of lib/weeks.ts for why that matters on a
 * boundary day.
 */
function targets(ctx: CommandContext): { ids: number[]; missing: number[] } {
  const positions = flag(ctx.args, 'n');
  if (positions) return resolvePositions(positions, resolveWeek(flag(ctx.args, 'week')));
  return { ids: parseIds(flag(ctx.args, 'id')), missing: [] };
}

function requireTargets(ctx: CommandContext, verb: string, example: string): { ids: number[]; missing: number[] } {
  const found = targets(ctx);
  if (found.ids.length === 0 && found.missing.length === 0) {
    throw new GroceryError(`${verb}: --n or --id is required.`, {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: example,
    });
  }
  return found;
}

export const markBoughtCommand: CommandSpec = {
  name: 'mark-bought',
  summary: 'Mark items bought by list position (--n) or by row id (--id).',
  usage: 'grocery.ts mark-bought (--n <positions> | --id <ids>) [--week <spec>] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const { ids, missing: missingPositions } = requireTargets(
      ctx,
      'mark-bought',
      'grocery.ts mark-bought --n 2,3   (positions in the message)  |  --id 47',
    );

    const done: ItemRow[] = [];
    // A position with no item behind it is reported the same way a stale id is:
    // skipped, named, and non-fatal. A shopping list is not worth failing a
    // whole command over one number that moved.
    const missing: number[] = [...missingPositions];
    for (const id of ids) {
      const info = db()
        .query("UPDATE items SET status = 'bought', bought_at = $bought_at WHERE id = $id AND status = 'pending'")
        .run({ $bought_at: now(), $id: id });
      if (info.changes > 0) {
        done.push(db().query('SELECT * FROM items WHERE id = $id').get({ $id: id }) as ItemRow);
      } else {
        missing.push(id);
      }
    }

    emit(ctx, { marked: done, skipped: missing }, (data) => {
      console.log(renderMarked(data.marked, pack, 'bought'));
      if (data.skipped.length) {
        console.log(`# skipped (not found or already bought): ${data.skipped.join(', ')}`);
      }
    });
  },
};

/**
 * `--id` only: the chat message lists PENDING items, so a position never names
 * a bought one, and resolving a week here would trip the rollover for nothing.
 */
export const unmarkCommand: CommandSpec = {
  name: 'unmark',
  summary: 'Put bought items back to pending. Row ids only — a position never names a bought item.',
  usage: 'grocery.ts unmark --id <ids> [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const ids = parseIds(flag(ctx.args, 'id'));
    if (ids.length === 0) {
      throw new GroceryError('unmark: --id is required.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'The ids come from `message --json` or `find`, never from a number the group quoted.',
      });
    }
    for (const id of ids) {
      db().query("UPDATE items SET status = 'pending', bought_at = NULL WHERE id = $id").run({ $id: id });
    }
    const rows = ids
      .map((id) => db().query('SELECT * FROM items WHERE id = $id').get({ $id: id }))
      .filter(Boolean) as ItemRow[];
    emit(ctx, rows, (data) => console.log(renderMarked(data, pack, 'pending')));
  },
};

export const removeCommand: CommandSpec = {
  name: 'remove',
  summary: 'Take items off the list by position (--n) or by row id (--id).',
  usage: 'grocery.ts remove (--n <positions> | --id <ids>) [--week <spec>] [--json]',
  async run(ctx: CommandContext) {
    const { ids, missing } = requireTargets(
      ctx,
      'remove',
      'grocery.ts remove --n 3   (position in the message)  |  --id 51',
    );
    const removed: ItemRow[] = [];
    for (const id of ids) {
      const row = db().query('SELECT * FROM items WHERE id = $id').get({ $id: id }) as ItemRow | null;
      const info = db().query('DELETE FROM items WHERE id = $id').run({ $id: id });
      if (info.changes > 0 && row) removed.push(row);
    }
    emit(ctx, { removed: removed.length, items: removed, skipped: missing }, (data) => {
      console.log(renderWorking(data.items));
      console.log(`# removed ${data.removed} item(s)`);
      if (data.skipped.length) console.log(`# skipped (no such position): ${data.skipped.join(', ')}`);
    });
  },
};
