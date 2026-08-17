/**
 * The chat message, the confirmations, and the two number spaces behind them.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * These go through the CLI rather than importing functions, and that is not a
 * workaround: the contract being protected here IS the CLI's stdout — the agent
 * forwards it verbatim — so asserting on the bytes the process writes is
 * asserting on the actual promise.
 *
 * ISOLATION. Every run below gets `MARKET_HOME` pointed at its own mkdtemp
 * directory, so a parallel test file can never share a database or a
 * `config.json` with this one. `MARKETY_CLASSIFY_DISABLED=1` keeps the aisle
 * classifier out of it: every fixture name here is one no pack claims, so left
 * on it would add seconds per `add` and make the suite depend on a gateway.
 *
 * BOTH LOCALES. The same cases run against `he-IL` and `en-US`, because the
 * whole point of the locale packs is that the rendering rules — direction marks,
 * Latin sealing, the confirm shape — are decided by the pack and not by the
 * language the tool was first written in. The RTL marks must be present in one
 * and absent in the other; anything else means a hardcoded literal survived.
 */
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const CLI = path.join(import.meta.dir, '..', 'grocery.ts');
const RLM = '‏';

let home = '';

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MARKET_HOME: home, MARKETY_CLASSIFY_DISABLED: '1' },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 0 };
}

/** `--json` output is `{"ok":true,"data":…}`; the test wants the data. */
function json<T = any>(...args: string[]): T {
  const res = run(...args, '--json');
  const parsed = JSON.parse(res.stdout) as { ok: boolean; data: T; error?: unknown };
  expect(parsed.ok, `expected ok, got ${res.stdout}`).toBe(true);
  return parsed.data;
}

function useLocale(tag: string): void {
  const res = run('config', '--locale', tag);
  expect(res.status, res.stderr).toBe(0);
}

/** Item names in message order, stripped of numbering, marks and quantities. */
function names(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^‏?\d+\./.test(line))
    .map((line) => line.replace(/^‏?\d+\.\s*/, '').replace(/\s*\(.*$/, '').trim());
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-message-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------------- localisation

describe('direction marks come from the pack, not from the code', () => {
  test('he-IL opens every line with the RTL mark', () => {
    useLocale('he-IL');
    run('add', '--name', 'חלב');
    run('add', '--name', 'ביצים');
    const lines = run('message').stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.startsWith(RLM)).toBe(true);
  });

  test('en-US carries no direction mark anywhere', () => {
    useLocale('en-US');
    run('add', '--name', 'milk');
    run('add', '--name', 'eggs');
    const out = run('message').stdout;
    expect(out.includes(RLM)).toBe(false);
    expect(out.split('\n')[0]).toBe('Shopping list');
    expect(out.split('\n')[1]).toBe('');
  });

  test('a Latin run is sealed in he-IL so the quantity does not fuse into it', () => {
    useLocale('he-IL');
    run('add', '--name', 'ביצים L', '--qty', '12');
    // Without the seal, `L` and `12` coalesce into one left-to-right run and the
    // quantity renders as part of the product name.
    expect(run('message').stdout).toContain(`ביצים L${RLM} (12)`);
  });

  test('the same Latin run is left alone in en-US', () => {
    useLocale('en-US');
    run('add', '--name', 'eggs L', '--qty', '12');
    expect(run('message').stdout).toContain('eggs L (12)');
  });

  test('the empty list is a one-line message in either language, not an error', () => {
    useLocale('he-IL');
    const hebrew = run('message');
    expect(hebrew.status).toBe(0);
    expect(hebrew.stdout.trim()).toBe(`${RLM}הרשימה ריקה`);

    useLocale('en-US');
    const english = run('message');
    expect(english.status).toBe(0);
    expect(english.stdout.trim()).toBe('The list is empty');
  });

  test('the confirm shape is rendered by the tool, in the pack’s words', () => {
    useLocale('en-US');
    // The product has to already exist: the FIRST add of a name creates it, and
    // a new product gets a marker of its own — asserted separately below.
    run('add', '--name', 'milk');
    run('remove', '--n', '1');

    const added = json('add', '--name', 'milk', '--qty', '2');
    expect(added.confirm.verb).toBe('added');
    expect(added.confirm.line).toBe('✓ Added: milk (2)');

    // A second add WITH --qty adds to the count and says so.
    const merged = json('add', '--name', 'milk', '--qty', '3');
    expect(merged.confirm.verb).toBe('merged');
    expect(merged.confirm.line).toBe('✓ Added: milk (3) — now 5');

    // A note-only correction moved no count, so it must not claim a purchase.
    const updated = json('add', '--name', 'milk', '--note', '3%');
    expect(updated.confirm.verb).toBe('updated');
    expect(updated.confirm.line).toBe('✓ Updated: milk (5)');
  });

  test('the same three shapes come out in Hebrew, direction-marked', () => {
    useLocale('he-IL');
    run('add', '--name', 'חלב');
    run('remove', '--n', '1');

    expect(json('add', '--name', 'חלב', '--qty', '2').confirm.line).toBe(`${RLM}✓ הוספתי: חלב (2)`);
    expect(json('add', '--name', 'חלב', '--qty', '3').confirm.line).toBe(`${RLM}✓ הוספתי: חלב (3) — עכשיו 5`);
    expect(json('add', '--name', 'חלב', '--note', '3%').confirm.line).toBe(`${RLM}✓ עדכנתי: חלב (5)`);
  });

  test('a brand-new product is marked as one, once', () => {
    useLocale('en-US');
    expect(json('add', '--name', 'tahini').confirm.line).toContain('— new product');
    // The second add merges, and a merge cannot be a new product.
    expect(json('add', '--name', 'tahini', '--qty', '1').confirm.line).not.toContain('new product');
  });
});

// ------------------------------------------------------------------ numbering

describe('the message numbers by position', () => {
  beforeEach(() => useLocale('en-US'));

  test('numbering is 1..N by position even when row ids gap', () => {
    for (const name of ['a', 'b', 'c', 'd']) run('add', '--name', name);
    run('remove', '--id', '2'); // punch a hole in the ids
    const text = run('message').stdout;
    expect(names(text)).toEqual(['a', 'c', 'd']);
    expect(text).toContain('2. c');
    expect(text).not.toContain('4.');
  });

  test('quantity is parenthesised and the note follows it', () => {
    run('add', '--name', 'ski cheese', '--qty', '4', '--note', '250 g 5%');
    expect(run('message').stdout).toContain('1. ski cheese (4) — 250 g 5%');
  });

  test('--json carries the position->id map alongside the text', () => {
    run('add', '--name', 'a');
    run('add', '--name', 'b');
    run('remove', '--id', '1');
    const data = json('message');
    // Exact shape on purpose: an agent reads these fields by name, so a field
    // appearing or vanishing is a contract change and should fail here first.
    expect(data.items).toEqual([
      { n: 1, id: 2, name: 'b', quantity: 1, unit: null, note: null, is_new_product: true },
    ]);
    expect(data.text).toContain('1. b');
  });

  test('bought items leave the message', () => {
    run('add', '--name', 'a');
    run('add', '--name', 'b');
    run('mark-bought', '--id', '1');
    expect(names(run('message').stdout)).toEqual(['b']);
  });
});

describe('--n resolves display positions, --id resolves row ids', () => {
  beforeEach(() => {
    useLocale('en-US');
    for (const name of ['a', 'b', 'c', 'd']) run('add', '--name', name);
    run('remove', '--id', '1'); // positions 1,2,3 are now ids 2,3,4
  });

  test('mark-bought --n acts on the position, not the id', () => {
    run('mark-bought', '--n', '1');
    expect(names(run('message').stdout)).toEqual(['c', 'd']);
  });

  test('a multi-position call resolves against one pre-write snapshot', () => {
    // The bug this guards: marking position 1 shifts everything up, so a naive
    // re-resolve would read position 2 off the already-shortened list and take
    // 'd' instead of 'c'.
    run('mark-bought', '--n', '1,2');
    expect(names(run('message').stdout)).toEqual(['d']);
  });

  test('remove --n acts on the position', () => {
    run('remove', '--n', '2');
    expect(names(run('message').stdout)).toEqual(['b', 'd']);
  });

  test('--id still means the row id', () => {
    run('mark-bought', '--id', '2');
    expect(names(run('message').stdout)).toEqual(['c', 'd']);
  });

  test('an out-of-range position is skipped, not fatal, and changes nothing', () => {
    const res = run('mark-bought', '--n', '99');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('99');
    expect(names(run('message').stdout)).toEqual(['b', 'c', 'd']);
  });

  test('neither flag is a usage error', () => {
    expect(run('mark-bought').status).toBe(2);
    expect(run('remove').status).toBe(2);
    expect(run('unmark').status).toBe(2);
  });

  test('unmark takes ids only and puts an item back on the list', () => {
    run('mark-bought', '--n', '1');
    expect(names(run('message').stdout)).toEqual(['c', 'd']);
    run('unmark', '--id', '2');
    expect(names(run('message').stdout)).toEqual(['b', 'c', 'd']);
  });
});

// ------------------------------------------------------- the missing quantity

describe('a missing count means one — on insert only', () => {
  beforeEach(() => useLocale('en-US'));

  test('a new item with no --qty gets 1, and an explicit --qty still wins', () => {
    run('add', '--name', 'crisps');
    run('add', '--name', 'juice', '--qty', '3');
    const out = run('message').stdout;
    expect(out).toContain('1. crisps (1)');
    expect(out).toContain('2. juice (3)');
  });

  test('re-adding without --qty does NOT bump the count', () => {
    // The carve-out that makes the default safe: on a merge, a missing --qty has
    // to keep meaning "leave the count alone", or correcting a note would
    // silently add one every time.
    run('add', '--name', 'milk', '--qty', '3');
    run('add', '--name', 'milk', '--note', '3%');
    expect(run('message').stdout).toContain('1. milk (3) — 3%');
  });

  test('re-adding WITH --qty adds to the stored count', () => {
    run('add', '--name', 'milk', '--qty', '3');
    run('add', '--name', 'milk', '--qty', '2');
    expect(run('message').stdout).toContain('1. milk (5)');
  });

  test('a merge onto a defaulted item does not double-count', () => {
    run('add', '--name', 'milk');
    run('add', '--name', 'milk', '--note', 'lactose free');
    expect(run('message').stdout).toContain('1. milk (1) — lactose free');
  });

  test('a bought row never merges — it gets a fresh one', () => {
    run('add', '--name', 'milk', '--qty', '2');
    run('mark-bought', '--n', '1');
    const again = json('add', '--name', 'milk', '--qty', '1');
    expect(again.action).toBe('added');
    expect(run('message').stdout).toContain('1. milk (1)');
  });
});

// ------------------------------------------------------------- working views

describe('working output is not mistakable for a message', () => {
  beforeEach(() => {
    useLocale('he-IL'); // the language where a pasted working view is worst
    run('add', '--name', 'חלב', '--qty', '2');
    run('add', '--name', 'ביצים L', '--qty', '12');
  });

  test('list is banner-marked, id-numbered, and carries no direction marks', () => {
    const out = run('list').stdout;
    expect(out.split('\n')[0]).toContain('do not send');
    expect(out).toContain('#1  [pending] חלב (2)');
    // The absence is the point: no RLM anywhere means pasting this into a chat
    // renders backwards, so the shortcut fails visibly.
    expect(out.includes(RLM)).toBe(false);
  });

  test('list and message share no line', () => {
    const working = new Set(run('list').stdout.split('\n').filter((line) => line.trim()));
    const message = run('message').stdout.split('\n').filter((line) => line.trim());
    expect(message.some((line) => working.has(line))).toBe(false);
  });

  test('the plain add output is a working view too', () => {
    const out = run('add', '--name', 'קפה').stdout;
    expect(out).toContain('do not send');
    expect(out).toContain('confirm.line');
    expect(out.includes(RLM)).toBe(false);
  });

  test('--json is unaffected by the working-view shaping', () => {
    const rows = json<{ id: number; name: string }[]>('list');
    expect(rows.map((item) => [item.id, item.name])).toEqual([
      [1, 'חלב'],
      [2, 'ביצים L'],
    ]);
  });

  test('an empty working view is still banner-marked', () => {
    run('remove', '--id', '1,2');
    const out = run('list').stdout;
    expect(out).toContain('do not send');
    expect(out).toContain('# (empty)');
  });
});

// --------------------------------------------------------------- the rollover

describe('the boundary question speaks in positions', () => {
  /**
   * Force the open week to look like it opened before the current boundary, so
   * the next command sees a week that is due to close. This is what the
   * rotation task walks into.
   */
  function ageTheWeek(): void {
    const handle = new Database(path.join(home, 'grocery.db'));
    handle.query("UPDATE weeks SET week_start = '2000-01-05' WHERE status = 'open'").run();
    handle.close();
  }

  beforeEach(() => {
    useLocale('en-US');
    for (const name of ['a', 'b', 'c', 'd']) run('add', '--name', name);
    run('remove', '--id', '1'); // ids 2,3,4 sit at positions 1,2,3
  });

  test('pre-rotate numbers pending by position and leaves the week open', () => {
    const asked = json('pre-rotate');
    expect(asked.pending.map((p: { n: number; id: number }) => [p.n, p.id])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(asked.boundary_passed).toBe(false);
    // Still open: the question has not closed the week it is asking about.
    expect(json('pre-rotate').week).not.toBeNull();
  });

  test('pre-rotate sees a passed boundary without tripping the rollover', () => {
    ageTheWeek();
    const asked = json('pre-rotate');
    expect(asked.boundary_passed).toBe(true);
    expect(asked.week.week_start).toBe('2000-01-05');
    // Read twice: still the old week, because this verb never writes.
    expect(json('pre-rotate').week.week_start).toBe('2000-01-05');
  });

  test('pre-rotate positions are the ones rotate --carry-n accepts', () => {
    const asked = json('pre-rotate');
    ageTheWeek();
    const rotated = json('rotate', '--carry-n', '1,3');
    expect(rotated.rotated).toBe(true);
    // Positions 1 and 3, NOT ids 1 and 3 — id 1 was removed above, so the two
    // number spaces disagree here and that is the point of the case.
    expect(rotated.carried.map((c: { name: string }) => c.name)).toEqual(['b', 'd']);
    expect([asked.pending[0].name, asked.pending[2].name]).toEqual(['b', 'd']);
  });

  test('marking and carrying in one answer resolve against the same snapshot', () => {
    // "1 and 2 I bought, carry 3" — after marking, position 3 would be off the
    // end of the shortened list, which is the bug this guards.
    ageTheWeek();
    const rotated = json('rotate', '--bought-n', '1,2', '--carry-n', '3');
    expect(rotated.marked_bought).toBe(2);
    expect(rotated.carried.map((c: { name: string }) => c.name)).toEqual(['d']);
    expect(rotated.closed_week.bought_count).toBe(2);
  });

  test('--bought-n lands in the CLOSING week, and nothing carries on its own', () => {
    ageTheWeek();
    const rotated = json('rotate', '--bought-n', '1');
    expect(rotated.closed_week.bought_count).toBe(1);
    expect(rotated.closed_week.pending_count).toBe(2);
    // Silence is not consent: an unbought item stays in the closed week and the
    // new week starts empty.
    expect(run('message').stdout.trim()).toBe('The list is empty');
  });

  test('carried items are copies — the originals stay pending in the closed week', () => {
    ageTheWeek();
    const rotated = json('rotate', '--carry-n', '1');
    expect(rotated.closed_week.pending_count).toBe(3);
    expect(rotated.carried).toHaveLength(1);
    expect(rotated.carried[0].id).not.toBe(rotated.closed_week.pending[0].id);
  });

  test('--carry all means everything left unbought after the marking', () => {
    ageTheWeek();
    run('rotate', '--bought-n', '1', '--carry', 'all', '--json');
    expect(names(run('message').stdout)).toEqual(['c', 'd']);
  });

  test('carried items are renumbered from 1 in the new week', () => {
    ageTheWeek();
    run('rotate', '--carry-n', '2,3', '--json');
    const data = json('message');
    expect(data.items.map((i: { n: number; name: string }) => [i.n, i.name])).toEqual([
      [1, 'c'],
      [2, 'd'],
    ]);
  });

  test('report numbers pending but never bought', () => {
    run('mark-bought', '--n', '1');
    const data = json('report', '--week', 'current');
    expect(data.pending.map((p: { n: number }) => p.n)).toEqual([1, 2]);
    expect(data.bought.every((b: { n?: number }) => b.n === undefined)).toBe(true);
  });

  test('report positions agree with what mark-bought --n acts on', () => {
    const data = json('report', '--week', 'current');
    const second = data.pending.find((p: { n: number }) => p.n === 2);
    run('mark-bought', '--n', '2');
    expect(names(run('message').stdout)).not.toContain(second.name);
  });
});

// ----------------------------------------------------------------- the sheet

describe('printable', () => {
  test('--json prints the sorted payload and renders no PDF', () => {
    useLocale('en-US');
    run('add', '--name', 'milk', '--qty', '2', '--note', '3%');
    const payload = json('printable');
    expect(payload.title).toBe('Shopping list');
    expect(payload.dir).toBe('ltr');
    expect(payload.categories[0].items[0]).toEqual({ name: 'milk', qty: '2', note: '3%' });
    // Nothing was rendered: no path anywhere in the output, and no new run
    // directory under the sheet root. That is the contract — `--json` is for
    // checking how a list will sort, and it must leave nothing on disk that
    // could be sent by mistake.
    expect(JSON.stringify(payload)).not.toContain('.pdf');
    const sheetRoot = '/tmp/grocery-sheets';
    const before = fs.existsSync(sheetRoot) ? fs.readdirSync(sheetRoot) : [];
    json('printable');
    const after = fs.existsSync(sheetRoot) ? fs.readdirSync(sheetRoot) : [];
    expect(after.filter((entry) => !before.includes(entry))).toEqual([]);
  });

  test('the payload takes its direction from the pack', () => {
    useLocale('he-IL');
    run('add', '--name', 'חלב');
    const payload = json('printable');
    expect(payload.dir).toBe('rtl');
    expect(payload.lang).toBe('he-IL');
    expect(payload.title).toBe('רשימת קניות');
  });

  test('an empty list refuses with the pack’s line and exit 3', () => {
    useLocale('en-US');
    const res = run('printable');
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('nothing to print');
  });
});

// ------------------------------------------------- the new-product marker

/**
 * The marker exists because the confirmation is not a reliable place to put it.
 *
 * `add --json` already returns `— new product ✨` in `confirm.line`, but reaching
 * the group depends on the assistant running `add --json` and forwarding that
 * string. An assistant that runs plain `add` and then `message` — which is what
 * happened on 2026-08-16 — produces a correct-looking list in which a product
 * invented seconds ago is indistinguishable from one bought for years. `אגוזים`
 * became a second product beside `אגוזי לוז` and the list said nothing.
 *
 * So it is asserted on `message`, the surface the group actually reads, and as a
 * property of the data rather than of the call that produced it.
 */
describe('a product’s first ever appearance is marked in the message', () => {
  test('a brand-new product is marked, in either language', () => {
    useLocale('en-US');
    run('add', '--name', 'hazelnuts', '--qty', '4');
    expect(run('message').stdout).toContain('hazelnuts (4) — new product');

    useLocale('he-IL');
    expect(run('message').stdout).toContain('מוצר חדש');
  });

  test('the marker goes away once the product has been listed before', () => {
    useLocale('en-US');
    run('add', '--name', 'hazelnuts');
    run('mark-bought', '--n', '1');
    // A second week, a second purchase: the product is no longer new to anyone.
    run('add', '--name', 'hazelnuts');
    const out = run('message').stdout;
    expect(out).toContain('hazelnuts');
    expect(out).not.toContain('new product');
  });

  test('a merge into an existing row is never marked', () => {
    useLocale('en-US');
    run('add', '--name', 'hazelnuts', '--qty', '4');
    run('add', '--name', 'hazelnuts', '--qty', '2');
    const out = run('message').stdout;
    expect(out).toContain('(6)');
    // Still the first appearance of the product, so the mark is correct here —
    // what must not happen is a second line.
    expect(names(out)).toEqual(['hazelnuts']);
  });

  test('two different products in one list are marked independently', () => {
    useLocale('en-US');
    run('add', '--name', 'hazelnuts');
    run('mark-bought', '--n', '1');
    run('add', '--name', 'hazelnuts'); // known now
    run('add', '--name', 'walnuts'); // brand new
    const lines = run('message').stdout.split('\n').filter((l) => /^\d+\./.test(l));
    expect(lines.find((l) => l.includes('hazelnuts'))).not.toContain('new product');
    expect(lines.find((l) => l.includes('walnuts'))).toContain('new product');
  });

  test('--json carries the same fact, so it need not be parsed out of prose', () => {
    useLocale('he-IL');
    run('add', '--name', 'אגוזי לוז', '--qty', '4');
    run('mark-bought', '--n', '1');
    run('add', '--name', 'אגוזי לוז');
    run('add', '--name', 'אגוזים', '--qty', '2');
    const data = json<{ items: { name: string; is_new_product: boolean }[] }>('message');
    const byName = new Map(data.items.map((i) => [i.name, i.is_new_product]));
    expect(byName.get('אגוזי לוז')).toBe(false);
    expect(byName.get('אגוזים')).toBe(true);
  });
});
