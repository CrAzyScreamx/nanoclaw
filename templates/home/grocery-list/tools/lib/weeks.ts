/**
 * The weekly cycle, and the one definition of "the list".
 *
 * The list runs in weeks that begin on the day and hour in `config.json`
 * (`weekStart`, default Wednesday 10:00 — see lib/locale.ts). Every item
 * belongs to the week that was open when it was added. Weeks are never deleted:
 * closing a week keeps its items so the history stays queryable (`report`,
 * `weeks`).
 *
 * A week is identified by the DATE of its opening day (`week_start`), so the
 * boundary hour lives only in `weekStartDate()` — the stored shape is a plain
 * date and one date still maps to exactly one week.
 *
 * ROLLOVER IS LAZY, NOT SCHEDULED
 * -------------------------------
 * `currentWeek()` compares the open week's start date against the most recent
 * boundary and closes/opens as needed. Self-healing: it does not depend on a
 * cron task firing, and a week nobody touched for days still rolls over on next
 * use. The scheduled task at the boundary only ANNOUNCES the rollover (via
 * `rotate`); if the host is down, only the announcement is missed.
 *
 * That laziness is why the pre-rotation review must run BEFORE the boundary:
 * any command at or after the boundary hour — including a plain `list` — trips
 * the rollover itself. `peekCurrentWeek()` is the single read that does not,
 * which is what gives that review something to run in. **It must never write.**
 *
 * Carry-over is opt-in and lives entirely in `rotate --carry-n`. A rollover on
 * its own always starts the new week empty. Carried items are COPIES — the
 * originals stay pending in the closed week, so the history keeps saying they
 * were never bought that week.
 */
import { parseIds } from './cli.ts';
import { db } from './db.ts';
import { readConfig } from './locale.ts';
import { now, weekStartDate } from './time.ts';
import type { ItemRow, WeekRow } from './types.ts';

/**
 * The date of the most recent week boundary. The config lookup lives here
 * rather than in `lib/time.ts` so that file stays free of any dependency on the
 * state directory.
 */
export function currentWeekStart(): string {
  return weekStartDate(readConfig().weekStart);
}

/**
 * The open week, closing the previous one first if the calendar has moved on.
 *
 * This is what almost every verb calls, and calling it IS what performs the
 * rollover. That is deliberate, and it is the reason `peekCurrentWeek()` exists
 * beside it. Idempotent: if the open week is already the current one it is
 * returned untouched, so calling this twice does not close anything twice.
 */
export function currentWeek(): WeekRow {
  const target = currentWeekStart();
  const open = db().query("SELECT * FROM weeks WHERE status = 'open'").get() as WeekRow | null;

  if (open && open.week_start === target) return open;

  if (open) {
    db().query("UPDATE weeks SET status = 'closed', closed_at = $closed_at WHERE id = $id").run({
      $closed_at: now(),
      $id: open.id,
    });
  }

  // A week row for this boundary may already exist if it was closed and then
  // re-entered (clock change, manual edit) — reopen rather than violate UNIQUE.
  const existing = db()
    .query('SELECT * FROM weeks WHERE week_start = $week_start')
    .get({ $week_start: target }) as WeekRow | null;
  if (existing) {
    db().query("UPDATE weeks SET status = 'open', closed_at = NULL WHERE id = $id").run({ $id: existing.id });
    return db().query('SELECT * FROM weeks WHERE id = $id').get({ $id: existing.id }) as WeekRow;
  }

  const info = db()
    .query("INSERT INTO weeks (week_start, opened_at, status) VALUES ($week_start, $opened_at, 'open')")
    .run({ $week_start: target, $opened_at: now() });
  return db().query('SELECT * FROM weeks WHERE id = $id').get({ $id: Number(info.lastInsertRowid) }) as WeekRow;
}

/**
 * The open week WITHOUT tripping the rollover — the read `pre-rotate` needs
 * before anyone decides whether a boundary has been crossed.
 *
 * **Never add a write to this function.** One stray write here closes the very
 * week the review question is about, and the question is then being asked about
 * a week the user can no longer change.
 */
export function peekCurrentWeek(): WeekRow | null {
  return db().query("SELECT * FROM weeks WHERE status = 'open'").get() as WeekRow | null;
}

/**
 * The most recently closed week — what `rotate` carries out of when the
 * rollover already happened under it, and what `--week last` resolves to.
 */
export function lastClosedWeek(): WeekRow | null {
  return db()
    .query("SELECT * FROM weeks WHERE status = 'closed' ORDER BY week_start DESC LIMIT 1")
    .get() as WeekRow | null;
}

/** Resolve `--week current|last|<id>` to a week row. */
export function resolveWeek(spec?: string): WeekRow | null {
  if (!spec || spec === 'current') return currentWeek();
  if (spec === 'last') {
    currentWeek(); // roll over first, so "last" means the week just closed
    return lastClosedWeek();
  }
  const id = Number(spec.replace(/^#/, ''));
  if (!Number.isFinite(id)) return null;
  return db().query('SELECT * FROM weeks WHERE id = $id').get({ $id: id }) as WeekRow | null;
}

/** The open week's id, or null — without tripping the rollover. */
export function openWeekId(): number | null {
  return peekCurrentWeek()?.id ?? null;
}

/**
 * A week's pending items in list order — the single definition of "the list".
 *
 * `message` renders from this and `resolvePositions` counts through it, so a
 * number the user reads off the chat message and a number they quote back can
 * never mean two different rows.
 */
export function pendingInWeek(week: WeekRow | null): ItemRow[] {
  if (!week) return [];
  return db()
    .query("SELECT * FROM items WHERE week_id = $week_id AND status = 'pending' ORDER BY id")
    .all({ $week_id: week.id }) as ItemRow[];
}

/** Every item in a week, pending and bought, in row order. */
export function itemsInWeek(week: WeekRow): ItemRow[] {
  return db().query('SELECT * FROM items WHERE week_id = $week_id ORDER BY id').all({ $week_id: week.id }) as ItemRow[];
}

/**
 * Which of these items are the FIRST time their product has ever been listed.
 *
 * The signal behind the new-product marker in `renderMessage`. Asked of the whole
 * `items` table and not of the week, because "new" has to mean new to the
 * household rather than new since Wednesday — a product bought every week for a
 * year would otherwise be flagged in every list it ever appears in.
 *
 * A first appearance is an event worth showing. It is the moment the CLI decided a
 * typed name was not any product on file, so it is the group's chance to say "that
 * is the thing we already call something else" while a merge is still cheap. It
 * stops being shown as soon as the product has a second item, which needs no
 * cleanup and no extra column.
 *
 * An item with no product is never marked — nothing was invented for it.
 */
export function firstAppearanceIds(items: ItemRow[]): Set<number> {
  const productIds = [...new Set(items.map((item) => item.product_id).filter((id): id is number => id != null))];
  if (productIds.length === 0) return new Set();

  // Parameterised per product rather than an `IN (...)`: bun:sqlite has no array
  // binding, and interpolating ids into SQL is how an injection gets in even when
  // the values came out of our own table.
  const firstItem = db().query('SELECT MIN(id) AS first_id FROM items WHERE product_id = $product_id');
  const firsts = new Set<number>();
  for (const productId of productIds) {
    const row = firstItem.get({ $product_id: productId }) as { first_id: number | null } | null;
    if (row?.first_id != null) firsts.add(row.first_id);
  }

  // Intersected with what is actually being rendered: a product's first item may
  // sit in a week that closed months ago, which is not this list's business.
  return new Set(items.filter((item) => firsts.has(item.id)).map((item) => item.id));
}

/**
 * Map display positions (`--n 2,3`) onto row ids.
 *
 * The chat message numbers items 1..N so the group reads a clean list rather
 * than a scatter of row ids, which means the number a user quotes back is a
 * position and not an id. Resolving it belongs here, in one query the CLI owns,
 * rather than in the agent counting through `list --json` — that is a
 * data-shaping step done from scratch on every turn, and it is exactly the kind
 * of step a small model gets right until the one time it does not.
 *
 * Resolution happens against a SNAPSHOT taken before any write, so `--n 2,3`
 * marks the second and third items of the list the user was looking at, not the
 * second and then whatever slid into third place behind it.
 */
export function resolvePositions(
  raw: string | undefined,
  week: WeekRow | null,
): { ids: number[]; missing: number[] } {
  const positions = parseIds(raw);
  const items = pendingInWeek(week);
  const ids: number[] = [];
  const missing: number[] = [];
  for (const n of positions) {
    const it = items[n - 1];
    if (n >= 1 && it) ids.push(it.id);
    else missing.push(n);
  }
  return { ids, missing };
}
