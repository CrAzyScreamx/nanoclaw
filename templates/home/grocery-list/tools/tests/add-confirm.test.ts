/**
 * The confirmation token — the thing that holds an `add` between the question
 * and the answer.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * WHAT IS BEING PROTECTED
 * -----------------------
 * When `add` cannot tell which product a typed name means, it writes NOTHING and
 * returns a token plus up to four candidates. The token carries the WHOLE add —
 * name, quantity, unit, note — and the confirming call ignores those flags
 * outright.
 *
 * That is not tidiness. The obvious alternative, where the confirming call
 * re-passes the fields, is the exact shape that lost "5%" and "250 g" off
 * printed sheets: every re-statement is a chance for a small model to drop a
 * qualifier it was carrying. The agent holds one opaque token and states intent;
 * it cannot drop a field it never held. So the round-trip below is the test that
 * matters most in this file — if the note stops surviving it, the feature is
 * back to where it started.
 *
 * The other invariant here is that an unknown or expired token FAILS LOUDLY. A
 * token that was quietly ignored would leave the group's item nowhere at all,
 * behind a confirmation that looked like it worked. Failing is the command
 * saying "run `add` again", not "guess".
 *
 * Isolation: `MARKET_HOME` is set before any dynamic import, and the tables are
 * wiped before every test as well — `bun test` shares one process and one module
 * registry across files, so whichever file loads lib/db.ts first decides the
 * state directory for all of them.
 */
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MARKET_HOME = mkdtempSync(join(tmpdir(), 'grocery-confirm-'));
process.env.MARKETY_CLASSIFY_DISABLED = '1';

const { db } = await import('../lib/db.ts');
const { bootstrap } = await import('../lib/bootstrap.ts');
const { writeConfig } = await import('../lib/locale.ts');
const { PENDING_TTL_MS, consumePendingAdd, createPendingAdd, purgeExpiredPendingAdds } = await import(
  '../lib/product-match.ts'
);

const TABLES = ['pending_adds', 'items', 'product_aliases', 'products', 'categories', 'app_state', 'weeks'];

function reset(): void {
  writeConfig({ locale: 'en-US' });
  bootstrap();
  const handle = db();
  handle.exec('PRAGMA foreign_keys = OFF');
  for (const table of TABLES) handle.exec(`DELETE FROM ${table}`);
  try {
    handle.exec('DELETE FROM sqlite_sequence');
  } catch {
    /* only exists once an AUTOINCREMENT table has been written to */
  }
  handle.exec('PRAGMA foreign_keys = ON');
  bootstrap();
}

beforeEach(reset);

/** Push a token's creation time into the past, the way a day of waiting would. */
function backdate(token: string, byMs: number): void {
  db()
    .query('UPDATE pending_adds SET created_at = created_at - $by WHERE token = $t')
    .run({ $by: byMs, $t: token });
}

test('a token carries every field the confirming call must not retype', () => {
  const held = createPendingAdd({
    name: 'ski cheese',
    qty: 5,
    unit: 'tub',
    note: '250 g 5%',
    candidates: [1, 2],
  });

  const taken = consumePendingAdd(held.token);
  expect(taken.payload.name).toBe('ski cheese');
  expect(taken.payload.qty).toBe(5);
  expect(taken.payload.unit).toBe('tub');
  // The qualifier is the whole point: it must survive the round trip untouched.
  expect(taken.payload.note).toBe('250 g 5%');
  expect(taken.payload.candidates).toEqual([1, 2]);
});

test('a token is single-use', () => {
  const held = createPendingAdd({ name: 'milk', qty: null, unit: null, note: null });
  expect(consumePendingAdd(held.token).payload.name).toBe('milk');
  expect(() => consumePendingAdd(held.token)).toThrow(/Unknown or expired/);
});

test('an unknown token fails loudly, and says what to do instead', () => {
  let thrown: unknown;
  try {
    consumePendingAdd('zzzz');
  } catch (error) {
    thrown = error;
  }
  const failure = thrown as { code: string; exitCode: number; message: string; hint?: string };
  expect(failure.code).toBe('pending_add_not_found');
  expect(failure.exitCode).toBe(5); // NOT_FOUND
  expect(failure.message).toContain('zzzz');
  expect(failure.hint).toMatch(/run `add` again/i);
});

test('a stale token is refused, and does not linger afterwards', () => {
  const held = createPendingAdd({ name: 'yesterday', qty: null, unit: null, note: null });
  // One day is deliberately long — the group's answer often arrives in a later
  // turn, sometimes the next morning. Past that, the question is stale.
  backdate(held.token, PENDING_TTL_MS + 60_000);

  expect(() => consumePendingAdd(held.token)).toThrow(/Unknown or expired/);
  // Refused AND consumed: a stale token must not sit there to be tried again.
  const left = db().query('SELECT COUNT(*) AS n FROM pending_adds').get() as { n: number };
  expect(left.n).toBe(0);
});

test('a token just inside the day still answers', () => {
  const held = createPendingAdd({ name: 'still fresh', qty: 2, unit: null, note: null });
  backdate(held.token, PENDING_TTL_MS - 60_000);
  expect(consumePendingAdd(held.token).payload.name).toBe('still fresh');
});

test('the purge drops unanswered questions and keeps live ones', () => {
  const stale = createPendingAdd({ name: 'old', qty: null, unit: null, note: null });
  const fresh = createPendingAdd({ name: 'new', qty: null, unit: null, note: null });
  backdate(stale.token, PENDING_TTL_MS + 60_000);

  purgeExpiredPendingAdds();

  const rows = db().query('SELECT token FROM pending_adds').all() as { token: string }[];
  expect(rows.map((r) => r.token)).toEqual([fresh.token]);
  expect(consumePendingAdd(fresh.token).payload.name).toBe('new');
});

test('tokens do not collide', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(createPendingAdd({ name: `x${i}`, qty: null, unit: null, note: null }).token);
  }
  expect(seen.size).toBe(200);
});

test('a token holds no week — the confirming call resolves one itself', () => {
  // Storing the asking week would let an answer that arrives after the boundary
  // land in the week that has since closed.
  const held = createPendingAdd({ name: 'weekless', qty: null, unit: null, note: null });
  expect(consumePendingAdd(held.token).payload).not.toHaveProperty('weekId');
});

test('a token is short enough to be quoted back, and is not a name', () => {
  const held = createPendingAdd({ name: 'milk', qty: null, unit: null, note: null });
  // Opaque and short: it is passed between two commands, never shown to the
  // group, and never confused with a product id or a list position.
  expect(held.token).toMatch(/^[0-9a-f]{4,8}$/);
});
