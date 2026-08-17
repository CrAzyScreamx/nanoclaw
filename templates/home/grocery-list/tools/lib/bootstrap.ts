/**
 * Everything that must be true before a verb runs, in order.
 *
 * This CLI has no migration runner: it just makes sure the shape and the seed
 * data it needs exist on every single invocation. Each step below is additive
 * and idempotent, so it is a no-op once done — the same self-healing shape as
 * the lazy week rollover, and for the same reason. Nothing here depends on an
 * operator remembering to run something, which matters more than usual for a
 * template: the first person to run it may never have read this file.
 *
 * THIS FILE OWNS THE SCHEMA
 * -------------------------
 * Every `CREATE TABLE` lives here, in one place, in dependency order —
 * `categories` before `products` because a product's aisle is a foreign key
 * into it, `products` before `items` for the same reason. The one exception is
 * `app_state`, whose DDL sits in lib/classify.ts next to the only code that
 * reads it; it is still created from here, in the order decided here.
 */
import { seedCategories } from './categories.ts';
import { ensureStateSchema, sweepUncategorised } from './classify.ts';
import { db } from './db.ts';
import { loadPack } from './locale.ts';
import { purgeExpiredPendingAdds } from './product-match.ts';
import { reapSheets } from './sheets.ts';

/**
 * How many uncategorised products one invocation may hand to the model.
 *
 * Bounded because the sweep runs before every verb: an unbounded sweep on a
 * long backlog would turn one `add` into a hundred API calls and a chat reply
 * that arrives a minute late. Three per run drains a realistic backlog within
 * an afternoon of ordinary use, and the classifier's own ten-minute cooldown
 * means an outage costs one attempt per ten minutes rather than three per verb.
 */
const SWEEP_LIMIT = 3;

export interface BootstrapOptions {
  /**
   * Whether this invocation may hand uncategorised products to the model.
   *
   * Defaults to true. `grocery.ts` passes false for `pre-rotate` and `rotate`:
   * those two are the rollover path, driven by a scheduled task on a clock with
   * a chat announcement waiting behind them, and an unreachable gateway would
   * turn `pre-rotate` into a curl timeout before it prints anything.
   *
   * Nothing is lost by skipping it — the sweep is self-healing by design, so
   * the next `add` or `list` picks the backlog up.
   */
  sweep?: boolean;
}

export function bootstrap(opts: BootstrapOptions = {}): void {
  const { sweep = true } = opts;
  // Not database work at all — see lib/sheets.ts for why a stale PDF is a
  // correctness problem and why this runs on every verb rather than only on
  // `printable`. It touches /tmp, which can fail for reasons that have nothing
  // to do with the list, so it never takes a verb down.
  try {
    reapSheets();
  } catch {
    /* a sheet that will not delete is not a reason to fail an add */
  }

  const handle = db();

  handle.exec(`
    CREATE TABLE IF NOT EXISTS weeks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL UNIQUE,
      opened_at  TEXT NOT NULL,
      closed_at  TEXT,
      status     TEXT NOT NULL DEFAULT 'open'
    )
  `);

  // Aisles. Seeded from the locale pack below and read-only to the agent: there
  // is no verb that creates one. `key` is the pack's stable identifier and
  // `name` is the display name in the current language — separate columns so
  // switching language rewrites what people read without orphaning a product.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      key          TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      is_catch_all INTEGER NOT NULL DEFAULT 0
    )
  `);

  // The thing itself, as opposed to the strings people type at it.
  // `category_id` is the ONLY owner of the aisle; items resolve theirs through
  // this table. `name_key` is UNIQUE, which is what makes a phrasing resolve to
  // exactly one product.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      name_key    TEXT NOT NULL UNIQUE,
      category_id INTEGER REFERENCES categories(id),
      created_at  TEXT NOT NULL,
      retired_at  TEXT
    )
  `);

  handle.exec(`
    CREATE TABLE IF NOT EXISTS product_aliases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      alias      TEXT NOT NULL,
      alias_key  TEXT NOT NULL UNIQUE,
      source     TEXT NOT NULL DEFAULT 'user',
      added_at   TEXT NOT NULL
    )
  `);

  // One purchase of one product, in one week. There is deliberately no
  // `category_id` here: the aisle belongs to the product, and storing it twice
  // let the two disagree.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id    INTEGER NOT NULL REFERENCES weeks(id),
      name       TEXT NOT NULL,
      quantity   REAL,
      unit       TEXT,
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      added_at   TEXT NOT NULL,
      bought_at  TEXT,
      product_id INTEGER REFERENCES products(id)
    )
  `);

  // The deferred half of `add`. The alternative — having the agent re-pass
  // --name/--qty/--note on the confirming call — is the exact shape that lost
  // "5%" and "250 g" off printed sheets before `printable` became one verb. The
  // agent carries one opaque token and states intent; every field it would
  // otherwise have to retype is held here. `created_at` is epoch milliseconds,
  // so the 24-hour TTL is a subtraction rather than a date parse.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pending_adds (
      token      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      quantity   REAL,
      unit       TEXT,
      note       TEXT,
      candidates TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )
  `);

  // The classifier's remembered auth shape and its cooldown deadline.
  ensureStateSchema();

  // Insert-missing and update display names from the active pack; never
  // deletes. Changing `config.locale` therefore renames the aisles in place,
  // leaving every product and every closed week exactly where it was.
  const pack = loadPack();
  seedCategories(pack);

  // An unanswered question stops being answerable after a day. Reaped here so
  // it happens whether or not anyone runs `add` again.
  purgeExpiredPendingAdds();

  // Self-healing for the one thing that can silently go wrong: a product
  // created while the classifier was unreachable sits in the catch-all aisle.
  // A bounded sweep gives those another chance on later runs, so an outage
  // costs a temporarily untidy sheet rather than a permanently wrong one.
  //
  // Skipped entirely on the rollover path — see BootstrapOptions.sweep. This is
  // the ONLY model call `bootstrap` can make, so gating it here is what keeps
  // the promise that `pre-rotate` and `rotate` never touch the network.
  //
  // NOTHING in here may throw. An `add` must succeed with the classifier
  // completely unreachable — that is the whole contract of lib/classify.ts, and
  // this is the one place that could break it by accident.
  if (!sweep) return;
  try {
    sweepUncategorised(pack, SWEEP_LIMIT);
  } catch {
    /* a classifier problem is never a reason to fail the verb that follows */
  }
}
