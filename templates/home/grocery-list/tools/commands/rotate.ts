/**
 * The boundary pair: look at the closing week, then turn it.
 *
 * These are the only two verbs the weekly scheduled tasks call, and the only
 * ones that may. `pre-rotate` is the single read in the whole CLI that does not
 * trip the lazy rollover; `rotate` is the only place carry-over exists. The
 * weekly-cycle narrative they implement is in the header of lib/weeks.ts.
 */
import { emit, flag, parseIds, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { db } from '../lib/db.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { foldForCompare } from '../lib/categories.ts';
import { loadPack, t } from '../lib/locale.ts';
import { lineMark, renderNumbered, renderPlain, withPositions } from '../lib/render.ts';
import { now } from '../lib/time.ts';
import type { ItemRow, WeekRow } from '../lib/types.ts';
import {
  currentWeek,
  currentWeekStart,
  itemsInWeek,
  lastClosedWeek,
  peekCurrentWeek,
  pendingInWeek,
} from '../lib/weeks.ts';

/**
 * Read the CLOSING week's pending items WITHOUT rolling over.
 *
 * Deliberately does not call `currentWeek()`. Every other verb rolls the week
 * over as a side effect, so at the boundary hour a plain `list` would close the
 * week out from under the very question being asked about it. This verb is the
 * only way to show the user "here is what looks unbought" while the week is
 * still open and their answer can still change it — which is why the review
 * task must run it FIRST, before anything else touches the database.
 */
export const preRotateCommand: CommandSpec = {
  name: 'pre-rotate',
  summary: 'What is still unbought in the open week. The one read that never rolls the week over.',
  usage: 'grocery.ts pre-rotate [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const open = peekCurrentWeek();
    if (!open) {
      // `week: null` means there is no open week at all: nothing to review,
      // nothing to announce, and the task that called this ends silently.
      emit(
        ctx,
        { week: null, boundary_passed: false, total: 0, bought_count: 0, pending_count: 0, pending: [] },
        () => console.log(`${lineMark(pack)}${t(pack, 'noOpenWeek')}`),
      );
      return;
    }

    const items = itemsInWeek(open);
    const pending = items.filter((item) => item.status === 'pending');
    const bought = items.filter((item) => item.status === 'bought');
    // True once the boundary has passed — the week is overdue to close and will
    // do so on the next ordinary command. A reminder task that sees this ran
    // late and must send nothing: the rollover it was warning about has already
    // happened.
    const boundaryPassed = open.week_start !== currentWeekStart();

    const payload = {
      week: { id: open.id, week_start: open.week_start },
      boundary_passed: boundaryPassed,
      total: items.length,
      bought_count: bought.length,
      pending_count: pending.length,
      // Numbered by POSITION: these are the items the review question is about,
      // and the numbers the user answers with come straight off this list.
      // `rotate --bought-n` / `--carry-n` invert them.
      pending: withPositions(pending),
    };

    emit(ctx, payload, (data) => {
      const m = lineMark(pack);
      console.log(
        `${m}${t(pack, 'weekSummary', {
          week: data.week!.week_start,
          total: data.total,
          bought: data.bought_count,
          pending: data.pending_count,
        })}`,
      );
      if (pending.length > 0) {
        console.log(`\n${m}${t(pack, 'sectionStillPending')}`);
        console.log(renderNumbered(pending, pack));
      }
    });
  },
};

/**
 * Trip the lazy rollover and report whether it ACTUALLY happened.
 *
 * `rotated: false` means the boundary has not been crossed yet — an early fire,
 * a clock skew, or a second run in the same week — and the agent must then stay
 * silent rather than announce a new week that did not start. Announcing off a
 * bare timestamp is exactly the bug this verb exists to prevent.
 *
 * Silence is never consent to carry items forward. Carry-over happens only
 * because someone asked for it, in this call, with `--carry-n`.
 */
export const rotateCommand: CommandSpec = {
  name: 'rotate',
  summary: 'Close the week if the boundary has passed, optionally marking and carrying items over.',
  usage:
    'grocery.ts rotate [--bought-n <positions>] [--bought-id <ids>] [--carry-n <positions>] [--carry all|<ids>] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();

    // The carry flags are read and CHECKED here, before anything is marked or
    // rolled over, so a malformed call costs nothing and can just be run again.
    //
    // A VALUE-LESS `--carry` means "carry everything still pending", the same as
    // `--carry all`. `flag()` only ever returns strings, so the raw flag has to
    // be read here or a bare `--carry` would quietly carry nothing and say
    // nothing about it. `--carry all` and `--carry 5,6` are why 'carry' must NOT
    // go into BOOLEAN_FLAGS: it takes a value, it just does not require one.
    //
    // `--carry-n` is deliberately NOT treated the same way. It is the flag the
    // weekly task fills in from the group's answer, so a `--carry-n` with no
    // numbers after it is a malformed answer, not a request for everything —
    // and reading it as carry-all would turn a dropped list of numbers into the
    // largest write this verb can make, on the one path where silence is never
    // consent to carry items forward. It fails loudly instead.
    const carryPositions = flag(ctx.args, 'carry-n');
    const carryRaw = carryPositions ?? flag(ctx.args, 'carry');
    const carryAll = ctx.args.flags['carry'] === true || carryRaw === 'all' || carryRaw === 'true';
    const carryNGiven = ctx.args.flags['carry-n'] !== undefined && ctx.args.flags['carry-n'] !== false;
    if (carryNGiven && !carryAll && parseIds(carryPositions).length === 0) {
      throw new GroceryError('rotate: --carry-n was given without any positions to carry.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'Positions are the numbers the group answered with: `rotate --carry-n 2,4`. To carry everything still unbought use `--carry all`; to carry nothing, leave the flag off entirely.',
      });
    }

    // `--bought` is not a flag of this verb, and saying so is the point: it is
    // a switch for `list --bought`, so passing it here parses as a boolean and
    // drops the ids after it into the positionals. Accepting it silently would
    // mark nothing and still report success — the very failure the `--bought-id`
    // name below exists to prevent — so an older caller gets told what to type.
    if (ctx.args.flags['bought'] !== undefined) {
      throw new GroceryError('rotate: there is no --bought flag.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'Use `--bought-n <positions>` for the numbers the group answered with, or `--bought-id <row ids>` for ids read out of `message --json`.',
      });
    }

    // `--bought-n` marks items bought BEFORE the rollover, in one step.
    //
    // This ordering is the whole point: `mark-bought` on its own resolves the
    // week first, so answering "yes, I bought 5 and 7" as two separate commands
    // would close the week and only then mark them. Same end state for the
    // items, but the rotation announcement would already be spent and would
    // report them as unbought. Marking here keeps the answer and the rollover
    // atomic, so the announcement tells the truth.
    const before = peekCurrentWeek();

    // Which week are we carrying OUT OF?
    //
    // Normally the week this call is about to close. But the rollover is lazy
    // and fires on ANY command, so between the review question and the user's
    // answer an unrelated "add milk" can close the week first. In that case the
    // open week is already the NEW one and carrying from it would be nonsense.
    // Fall back to the most recent closed week, which is exactly the one the
    // question was asked about. Without this, an innocent message in the answer
    // window silently turned "yes, carry them" into a no-op.
    //
    // Resolved BEFORE anything is written, because the position snapshot below
    // has to be the list the user was actually looking at.
    const willRotate = !!before && before.week_start !== currentWeekStart();
    const carrySource: WeekRow | null = willRotate ? before : lastClosedWeek();

    // THE snapshot: the closing week's pending items, in the order they were
    // numbered in the question. EVERY position in this call resolves against
    // it, so "3 and 5 I bought, carry the rest" means the 3rd and 5th lines of
    // the message the user is replying to — not of a list that has already had
    // two items marked off it.
    const answerList = pendingInWeek(carrySource);
    const atPosition = (raw: string | undefined): number[] =>
      parseIds(raw)
        .map((n) => answerList[n - 1]?.id)
        .filter((id): id is number => id != null);

    // `--bought-n 3,5` are positions from the question; `--bought-id 47,51` are
    // row ids. The task prompts use the first, because positions are the only
    // numbers the group ever sees.
    //
    // The id form is `--bought-id` and not `--bought` because `bought` is
    // already a SWITCH elsewhere in this tool — `list --bought`. One name
    // meaning two things is how a caller ends up handing ids to a boolean and
    // marking nothing while the command reports success, so this verb refuses
    // the bare name outright (above) rather than guessing at it. lib/cli.ts
    // deliberately keeps `bought` OUT of BOOLEAN_FLAGS, which is what lets that
    // guard see the ids at all. The `--carry` / `--carry-n` pair can keep the
    // short name because `carry` is not a switch anywhere.
    const boughtPositions = flag(ctx.args, 'bought-n');
    const marked = boughtPositions ? atPosition(boughtPositions) : parseIds(flag(ctx.args, 'bought-id'));
    let markedCount = 0;
    for (const id of marked) {
      markedCount += db()
        .query("UPDATE items SET status = 'bought', bought_at = $bought_at WHERE id = $id AND status = 'pending'")
        .run({ $bought_at: now(), $id: id }).changes;
    }

    const current = currentWeek();
    const rotated = !!before && before.week_start !== current.week_start;

    // Re-read after the marking above: anything just marked bought has dropped
    // out, which is what makes `--carry all` mean "everything STILL unbought".
    const carryable = pendingInWeek(carrySource);

    // Resolved against `carryable`, i.e. AFTER the marking above — which is
    // what makes carry-all mean "everything still unbought". The flags
    // themselves were read and validated at the top of the verb, before any of
    // this wrote anything.
    const carryIds = carryAll
      ? carryable.map((item) => item.id)
      : carryPositions
        ? atPosition(carryPositions)
        : parseIds(carryRaw);

    const carried: ItemRow[] = [];
    const carrySkipped: string[] = [];

    if (carryIds.length > 0 && carrySource && carrySource.id !== current.id) {
      const byId = new Map(carryable.map((item) => [item.id, item]));
      for (const id of carryIds) {
        const source = byId.get(id);
        if (!source) continue; // unknown id, or marked bought a moment ago

        // SKIP rather than merge when the product is already on the new list.
        // Merging would add the quantities, so running this twice — which the
        // recovery path above makes possible — would silently double every
        // carried item. Skipping makes the whole verb safe to repeat, and a
        // fresh add from this week rightly wins over last week's copy.
        //
        // Re-read inside the loop on purpose: it has to see the rows this loop
        // has already inserted, or carrying the same product twice in one
        // answer would land it twice.
        const existing = pendingInWeek(current);
        // Same product, however it was spelled — a carried "Coca-Cola Zero"
        // must not land beside a "zero" someone already added to the new week.
        if (
          existing.some((item) =>
            item.product_id != null && source.product_id != null
              ? item.product_id === source.product_id
              : foldForCompare(item.name) === foldForCompare(source.name),
          )
        ) {
          carrySkipped.push(source.name);
          continue;
        }

        // The carried copy keeps the original's product rather than re-resolving
        // it. Same name, same shelf — and re-resolving would put a model call on
        // the rotation path, where a stall costs the whole announcement.
        //
        // The ORIGINAL is deliberately left untouched: it genuinely was not
        // bought, and the closed week's history has to keep saying so. Carried
        // rows are fresh items, not moved ones.
        const insert = db()
          .query(
            'INSERT INTO items (week_id, name, quantity, unit, note, status, added_at, product_id) VALUES ($week_id, $name, $quantity, $unit, $note, $status, $added_at, $product_id)',
          )
          .run({
            $week_id: current.id,
            $name: source.name,
            $quantity: source.quantity,
            $unit: source.unit,
            $note: source.note,
            $status: 'pending',
            $added_at: now(),
            $product_id: source.product_id,
          });
        carried.push(
          db().query('SELECT * FROM items WHERE id = $id').get({ $id: Number(insert.lastInsertRowid) }) as ItemRow,
        );
      }
    }

    const closed = rotated
      ? (db().query('SELECT * FROM weeks WHERE id = $id').get({ $id: before!.id }) as WeekRow)
      : null;
    const closedItems = closed ? itemsInWeek(closed) : [];
    const bought = closedItems.filter((item) => item.status === 'bought');
    const pending = closedItems.filter((item) => item.status === 'pending');

    const payload = {
      rotated,
      marked_bought: markedCount,
      // True when the week had already been rolled over by an unrelated command
      // before this call — the answer still landed, but the rollover was not
      // this call's doing and must not be announced as if it just happened.
      already_rotated: !rotated && carried.length > 0,
      carried_from: carrySource ? { id: carrySource.id, week_start: carrySource.week_start } : null,
      carried_count: carried.length,
      carried,
      already_on_list: carrySkipped,
      current_week: { id: current.id, week_start: current.week_start },
      closed_week: closed
        ? {
            id: closed.id,
            week_start: closed.week_start,
            total: closedItems.length,
            bought_count: bought.length,
            pending_count: pending.length,
            bought,
            pending,
          }
        : null,
    };

    emit(ctx, payload, (data) => {
      const m = lineMark(pack);
      if (data.marked_bought > 0) console.log(`${m}${t(pack, 'markedBoughtCount', { count: data.marked_bought })}`);
      if (data.already_on_list.length > 0) {
        console.log(`${m}${t(pack, 'carrySkipped', { names: data.already_on_list.join(', ') })}`);
      }
      if (!data.rotated) {
        console.log(`${m}${t(pack, 'noRotation', { week: data.current_week.week_start })}`);
        if (carried.length > 0) {
          console.log(`${m}${t(pack, 'rotationAlreadyDone', { week: data.carried_from!.week_start })}`);
          console.log(`\n${m}${t(pack, 'sectionCarriedCurrent')}`);
          console.log(renderPlain(carried, pack));
        }
        return;
      }
      console.log(`${m}${t(pack, 'newWeekOpened', { week: data.current_week.week_start })}`);
      console.log(
        `${m}${t(pack, 'closedWeekSummary', {
          week: data.closed_week!.week_start,
          total: data.closed_week!.total,
          bought: data.closed_week!.bought_count,
          pending: data.closed_week!.pending_count,
        })}`,
      );
      // Both lists UNNUMBERED: the closed week's leftovers are history now, and
      // the carried copies live in the NEW week, where `message` numbers them. A
      // number printed here could only be quoted back at the wrong list.
      if (pending.length > 0) {
        console.log(`\n${m}${t(pack, 'sectionNotBought')}`);
        console.log(renderPlain(pending, pack));
      }
      if (carried.length > 0) {
        console.log(`\n${m}${t(pack, 'sectionCarriedNew')}`);
        console.log(renderPlain(carried, pack));
      }
    });
  },
};
