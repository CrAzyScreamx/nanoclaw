/**
 * The locale packs and `config.json`.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * Two things are checked here that nothing else can check:
 *
 *   SYMMETRY. Every pack must carry every key, because `t()` throws on a
 *   missing one — deliberately, since a silent gap is a message sent to the
 *   group with a hole in it. That makes an incomplete pack a test failure
 *   instead of a runtime surprise, which is the whole point of the throw.
 *
 *   ISOLATION. `MARKET_HOME` is read when `lib/db.ts` is first EVALUATED, and
 *   ES imports are evaluated before any statement in this file. So the variable
 *   is set first and the modules are reached by dynamic import — a static
 *   `import` at the top would resolve the path before the assignment ran, and
 *   every parallel test file would share `/workspace/agent/market`.
 *
 * Every test file in this tree follows that pattern. Copy it; do not "tidy" it
 * into static imports.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'grocery-locale-'));
process.env.MARKET_HOME = HOME;

const { CONFIG_PATH, listPacks, loadPack, readConfig, t, writeConfig, catchAllCategory } =
  await import('../lib/locale.ts');

const TAGS = ['he-IL', 'en-US'];

test('both shipped packs are discoverable', () => {
  const packs = listPacks();
  for (const tag of TAGS) expect(packs).toContain(tag);
});

test('every pack loads and declares a direction, aisles and both prompts', () => {
  for (const tag of TAGS) {
    const pack = loadPack(tag);
    expect(pack.tag).toBe(tag);
    expect(['rtl', 'ltr']).toContain(pack.dir);
    expect(pack.categories.length).toBe(11); // 10 aisles + the catch-all
    expect(pack.prompts.aisle.length).toBeGreaterThan(40);
    expect(pack.prompts.identity.length).toBeGreaterThan(40);
  }
});

test('packs carry the same string and error keys', () => {
  const [first, ...rest] = TAGS.map((tag) => loadPack(tag));
  const strings = Object.keys(first!.strings).sort();
  const errors = Object.keys(first!.errors).sort();
  for (const pack of rest) {
    expect(Object.keys(pack.strings).sort()).toEqual(strings);
    expect(Object.keys(pack.errors).sort()).toEqual(errors);
  }
  // No blank values: an empty string passes a key check and prints nothing.
  for (const tag of TAGS) {
    const pack = loadPack(tag);
    for (const [key, value] of Object.entries({ ...pack.strings, ...pack.errors })) {
      expect(value.trim(), `${tag}.${key} is empty`).not.toBe('');
    }
  }
});

test('packs describe the same aisles, in the same order, with one catch-all', () => {
  const shape = (tag: string) =>
    loadPack(tag).categories.map((c) => `${c.key}:${c.sort}:${c.catchAll ? 'catch' : ''}`);
  const first = shape(TAGS[0]!);
  for (const tag of TAGS.slice(1)) expect(shape(tag)).toEqual(first);
  for (const tag of TAGS) {
    expect(loadPack(tag).categories.filter((c) => c.catchAll)).toHaveLength(1);
    // The catch-all sorts last so the sheet ends with it, whatever it is called.
    const catchAll = catchAllCategory(loadPack(tag));
    const sorts = loadPack(tag).categories.map((c) => c.sort);
    expect(catchAll.sort).toBe(Math.max(...sorts));
  }
});

test('the sheet filename stem is filesystem-safe in every pack', () => {
  for (const tag of TAGS) {
    const stem = loadPack(tag).strings.sheetFilenameStem!;
    expect(stem).not.toMatch(/[/\\]/);
    expect(stem.trim()).toBe(stem);
    expect(stem).not.toBe('');
  }
});

test('t() fills placeholders and throws on a key no pack has', () => {
  const pack = loadPack('en-US');
  expect(t(pack, 'weekSummary', { week: '2026-08-12', total: 7, bought: 4, pending: 3 })).toBe(
    'Week 2026-08-12 — 7 total, 4 bought, 3 not bought',
  );
  // An unknown placeholder is left visible rather than rendered as "undefined".
  expect(t(pack, 'mergeTail', {})).toBe('— now {total}');
  // Error lines are reachable through the same accessor as display strings.
  expect(t(pack, 'listEmptyNothingToPrint')).toContain('nothing to print');
  expect(() => t(pack, 'noSuchStringAnywhere')).toThrow(/no string/);
});

test('an unknown locale tag names the tags that do exist', () => {
  let message = '';
  try {
    loadPack('fr-CA');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('fr-CA');
  for (const tag of TAGS) expect(message).toContain(tag);
  // A path-shaped tag is refused rather than resolved.
  expect(() => loadPack('../../etc/passwd')).toThrow();
});

test('config defaults when the file is absent', () => {
  rmSync(CONFIG_PATH, { force: true });
  const config = readConfig();
  expect(config.locale).toBe('en-US');
  expect(config.weekStart).toEqual({ day: 3, hour: 10 });
  expect(config.rememberReceiptCorrections).toBe(false);
});

test('config round-trips through an atomic write', () => {
  writeConfig({ locale: 'he-IL' });
  writeConfig({ weekStart: { day: 0, hour: 8 } });
  const written = writeConfig({ rememberReceiptCorrections: true });

  expect(written.locale).toBe('he-IL');
  expect(readConfig()).toEqual({
    locale: 'he-IL',
    weekStart: { day: 0, hour: 8 },
    rememberReceiptCorrections: true,
  });

  // What landed on disk is exactly what comes back, and no temp file survived.
  expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))).toEqual(readConfig());
  expect(existsSync(`${CONFIG_PATH}.tmp`)).toBe(false);
});

test('a bad locale or week start is refused and leaves the file untouched', () => {
  const before = readFileSync(CONFIG_PATH, 'utf8');
  expect(() => writeConfig({ locale: 'xx-YY' })).toThrow(/Unknown locale/);
  expect(() => writeConfig({ weekStart: { day: 9, hour: 10 } })).toThrow(/0-6/);
  expect(() => writeConfig({ weekStart: { day: 3, hour: 99 } })).toThrow(/0-23/);
  expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(before);
});

test('a corrupt config file falls back to the defaults rather than throwing', () => {
  writeFileSync(CONFIG_PATH, '{ this is not json', 'utf8');
  const config = readConfig();
  expect(config.locale).toBe('en-US');
  expect(config.weekStart).toEqual({ day: 3, hour: 10 });
  rmSync(HOME, { recursive: true, force: true });
});
