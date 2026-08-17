/**
 * The database handle, opened once per invocation.
 *
 * WHERE IT LIVES, AND WHY THE PATH IS ABSOLUTE
 * -------------------------------------------
 * The plugin directory is mounted READ-ONLY at
 * `/workspace/agent/plugins/grocery-list/` and is never written to. Everything
 * this template remembers lives under `/workspace/agent/market/`:
 *
 *   grocery.db     the list, its history, products and aisles
 *   config.json    locale, week start, the receipt-corrections switch (locale.ts)
 *
 * The path must stay absolute: derived from `import.meta.dir` it becomes a
 * read-only-filesystem error the moment this code ships inside a plugin.
 *
 * MARKET_HOME is a TEST HOOK ONLY — it lets these tools be exercised outside a
 * container. It is a directory path, never a credential.
 *
 * TESTS: `MARKET_HOME` is read when this module is first EVALUATED, and ES
 * imports are evaluated before any statement in the importing file. A test that
 * wants its own state directory therefore has to set the variable and then
 * reach the modules by dynamic import:
 *
 *     process.env.MARKET_HOME = mkdtempSync(join(tmpdir(), 'grocery-'));
 *     const { bootstrap } = await import('./lib/bootstrap.ts');
 *
 * A static `import` at the top of the file would resolve the path first and
 * every parallel test would share `/workspace/agent/market`.
 *
 * Note: bun:sqlite does NOT strip the `$` prefix from named params — `$name`
 * must appear in both the SQL and the JS keys. Every query here is written that
 * way. Opening the file is all that happens in this module; the SHAPE is
 * `bootstrap.ts`, which the entry point runs before it dispatches.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';

export const STATE_DIR: string = process.env.MARKET_HOME ?? '/workspace/agent/market';
export const DB_PATH = `${STATE_DIR}/grocery.db`;

let handle: Database | null = null;

/**
 * The handle, opened on first use and reused for the rest of the process.
 *
 * Lazy rather than module-level so that `--help` and a usage error never create
 * a database file, and so importing a module for its pure functions (a test
 * asking `foldForCompare` a question) does not touch the disk.
 */
export function db(): Database {
  if (handle) return handle;
  mkdirSync(STATE_DIR, { recursive: true });
  const opened = new Database(DB_PATH, { create: true });
  // WAL keeps a reader (`pre-rotate` mid-question) from blocking the write that
  // answers it. It leaves `-wal`/`-shm` siblings in the state directory; that is
  // expected and they are not data you need to back up separately.
  opened.exec('PRAGMA journal_mode = WAL');
  // Not decoration: `items.product_id` and `products.category_id` are the whole
  // aisle resolution path, and an orphaned row there prints under no heading.
  opened.exec('PRAGMA foreign_keys = ON');
  handle = opened;
  return handle;
}
