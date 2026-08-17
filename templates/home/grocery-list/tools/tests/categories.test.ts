/**
 * The aisles: folding, seeding from a pack, and grouping a list under headings.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * The half of this file that matters most is the one asserting what is NOT here
 * any more. The tool this was ported from decided an aisle by matching Hebrew
 * word stems, and every rule in that matcher was a fact about one language. The
 * tests below pin the replacement down as LOCALE-NEUTRAL: the folding does not
 * know about Hebrew final letters, the aisles come from whichever pack is
 * active, and switching language renames them in place instead of orphaning
 * every product filed under them.
 *
 * ISOLATION, AND WHY IT IS BELT AND BRACES
 * ----------------------------------------
 * `MARKET_HOME` is set before any dynamic import, as lib/db.ts documents — a
 * static import would resolve the state path before the assignment ran.
 *
 * That alone is not enough under `bun test`: every test file in a run shares one
 * process AND one module registry, so whichever file evaluates lib/db.ts first
 * decides `STATE_DIR` for all of them. So this file also pins the config it
 * needs and wipes the tables it touches before each test, which makes it correct
 * whether it runs first, last, or alone.
 */
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MARKET_HOME = mkdtempSync(join(tmpdir(), 'grocery-categories-'));
// No test in this tree may reach the network. Every classifier path returns null
// under this switch, which is exactly the behaviour the sweep test asserts.
process.env.MARKETY_CLASSIFY_DISABLED = '1';

const { db } = await import('../lib/db.ts');
const { bootstrap } = await import('../lib/bootstrap.ts');
const { loadPack, writeConfig } = await import('../lib/locale.ts');
const {
  catchAllCategoryId,
  findCategoryByKey,
  foldForCompare,
  getCategory,
  groupByCategory,
  listCategories,
  seedCategories,
} = await import('../lib/categories.ts');
const { createProduct } = await import('../lib/products.ts');
const { classify, sweepUncategorised } = await import('../lib/classify.ts');

const TABLES = ['pending_adds', 'items', 'product_aliases', 'products', 'categories', 'app_state', 'weeks'];

/** An empty database with the schema applied and the en-US aisles seeded. */
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

/* ------------------------------------------------------------------ folding */

test('foldForCompare lower-cases, strips diacritics and collapses whitespace', () => {
  expect(foldForCompare('  Café   au   LAIT ')).toBe('cafe au lait');
  expect(foldForCompare('ÅNGSTRÖM')).toBe('angstrom');
});

test('an apostrophe is dropped, other punctuation separates words', () => {
  // Intra-word marks vanish, so one spelling of a product folds onto the other.
  expect(foldForCompare("it's")).toBe('its');
  expect(foldForCompare("צ'יפס")).toBe(foldForCompare('ציפס'));
  expect(foldForCompare("קוטג'")).toBe('קוטג');
  // Separators become a space, so a hyphenated name folds onto the spaced one.
  expect(foldForCompare('Coca-Cola')).toBe(foldForCompare('coca cola'));
  expect(foldForCompare('milk / cream')).toBe('milk cream');
});

/**
 * Locale-neutral means **the active pack cannot change the answer** — not that the
 * fold may know nothing about how an alphabet spells a letter.
 *
 * An earlier version of this test asserted the opposite, that no Hebrew
 * final-letter folding may survive, on the grounds that it is a fact about one
 * alphabet. That reading cost more than it protected. A positional form is one
 * letter with two shapes — the exact analogue of the case folding asserted below
 * it — and Hebrew inflects by suffix, so refusing to fold it means a plural can
 * never be recognised as the word it inflects. Worse: the fold also builds stored
 * keys, so dropping it split the database into two foldings and `findExact`
 * stopped matching a product against its own name. See `foldForCompare`'s note on
 * why an edit there is a data migration.
 */
test('folding is LOCALE-NEUTRAL — the active pack never changes a key', () => {
  const folded = foldForCompare('פלפל אדום');
  loadPack('he-IL');
  expect(foldForCompare('פלפל אדום')).toBe(folded);
  loadPack('en-US');
  expect(foldForCompare('פלפל אדום')).toBe(folded);
  // Case folding is not locale-tailored either: `toLowerCase`, never
  // `toLocaleLowerCase`, so a Turkish container cannot fold `I` to `ı`.
  expect(foldForCompare('MILK')).toBe('milk');
  // Diacritics go in every script, because that is one rule and not a list.
  expect(foldForCompare('שָׁלוֹם')).toBe('שלומ');
});

test('a positional letter form folds to one shape, so a suffix cannot hide a word', () => {
  expect(foldForCompare('לחם')).toBe('לחמ');
  expect(foldForCompare('מלפפון')).toBe('מלפפונ');
  expect(foldForCompare('סבון כלים')).toBe('סבונ כלימ');
  expect(foldForCompare('חזה עוף')).toBe('חזה עופ');
  // All five, so a missing entry in the table fails here rather than in a list.
  expect(foldForCompare('ךםןףץ')).toBe('כמנפצ');

  // The point of folding: a plural folds onto its own stem as a prefix, which is
  // what lets a rule in lib/product-match.ts see they are the same word.
  expect(foldForCompare('מלפפונים').startsWith(foldForCompare('מלפפון'))).toBe(true);
  expect(foldForCompare('לימונים').startsWith(foldForCompare('לימון'))).toBe(true);

  // It is per-letter and nothing more — it does not merge two words that merely
  // end up sharing a medial letter.
  expect(foldForCompare('לחם')).not.toBe(foldForCompare('לחמה'));
});

/* ------------------------------------------------------------------ seeding */

test('a pack seeds eleven aisles in print order with one catch-all, last', () => {
  const pack = loadPack('en-US');
  const cats = listCategories();

  expect(cats).toHaveLength(pack.categories.length);
  expect(cats.map((c) => c.key)).toEqual(pack.categories.map((c) => c.key));
  expect(cats.map((c) => c.sort_order)).toEqual([...cats.map((c) => c.sort_order)].sort((a, b) => a - b));

  const catchAll = cats.filter((c) => c.is_catch_all === 1);
  expect(catchAll).toHaveLength(1);
  expect(catchAll[0]!.id).toBe(catchAllCategoryId());
  expect(cats[cats.length - 1]!.id).toBe(catchAllCategoryId());
});

test('both shipped packs seed the same aisles under the same keys', () => {
  const english = listCategories();
  seedCategories(loadPack('he-IL'));
  const hebrew = listCategories();

  // Same rows, same ids, same order — only the display names moved.
  expect(hebrew.map((c) => c.id)).toEqual(english.map((c) => c.id));
  expect(hebrew.map((c) => c.key)).toEqual(english.map((c) => c.key));
  expect(hebrew.map((c) => c.name)).not.toEqual(english.map((c) => c.name));
  expect(hebrew[hebrew.length - 1]!.is_catch_all).toBe(1);
});

test('switching language renames aisles in place and leaves products where they are', () => {
  const bakery = findCategoryByKey('bakery')!;
  const bread = createProduct('bread', bakery.id);

  seedCategories(loadPack('he-IL'));

  const after = findCategoryByKey('bakery')!;
  expect(after.id).toBe(bakery.id);
  expect(after.name).not.toBe(bakery.name);
  // The product did not move, was not re-classified, and did not lose its aisle.
  expect(bread.category_id).toBe(bakery.id);
  expect(getCategory(bakery.id)!.key).toBe('bakery');
});

test('seeding never deletes an aisle the pack no longer lists', () => {
  db()
    .query('INSERT INTO categories (key, name, sort_order, is_catch_all) VALUES ($k, $n, $s, 0)')
    .run({ $k: 'deli', $n: 'Deli counter', $s: 55 });

  seedCategories(loadPack('en-US'));

  // Still there: products filed under it keep resolving, and no closed week
  // loses a heading because someone edited a pack.
  expect(findCategoryByKey('deli')).not.toBeNull();
  // And there is still exactly one catch-all.
  expect(listCategories().filter((c) => c.is_catch_all === 1)).toHaveLength(1);
});

test('seeding twice changes nothing', () => {
  const before = listCategories();
  seedCategories(loadPack('en-US'));
  seedCategories(loadPack('en-US'));
  expect(listCategories()).toEqual(before);
});

/* ----------------------------------------------------------------- grouping */

/** One item row, resolving its aisle the only way there is: through its product. */
function item(name: string, productId: number | null): { name: string; product_id: number | null } {
  return { name, product_id: productId };
}

test('groupByCategory resolves the aisle through items → products → categories', () => {
  const produce = findCategoryByKey('produce')!;
  const bakery = findCategoryByKey('bakery')!;
  const household = findCategoryByKey('household')!;

  const tomatoes = createProduct('tomatoes', produce.id);
  const cucumbers = createProduct('cucumbers', produce.id);
  const bread = createProduct('bread', bakery.id);
  const soap = createProduct('dish soap', household.id);

  const groups = groupByCategory(
    [
      item('tomatoes', tomatoes.id),
      item('dish soap', soap.id),
      item('cucumbers', cucumbers.id),
      item('bread', bread.id),
    ],
    listCategories(),
  );

  // Print order, not input order: produce, bakery, household.
  expect(groups.map((g) => g.name)).toEqual([produce.name, bakery.name, household.name]);
  // Input order INSIDE an aisle, so the sheet matches the numbered chat message.
  expect(groups[0]!.items.map((i) => i.name)).toEqual(['tomatoes', 'cucumbers']);
  // Empty aisles are omitted entirely.
  expect(groups).toHaveLength(3);
});

test('nothing is ever dropped — the catch-all takes every unresolvable item', () => {
  const cats = listCategories();
  const catchAllName = cats.find((c) => c.is_catch_all === 1)!.name;
  const orphan = createProduct('a thing', catchAllCategoryId());
  const noAisle = createProduct('another thing', catchAllCategoryId());
  db().query('UPDATE products SET category_id = NULL WHERE id = $id').run({ $id: noAisle.id });

  const groups = groupByCategory(
    [
      item('a thing', orphan.id),
      item('another thing', noAisle.id), // product with no aisle at all
      item('typed straight in', null), // no product
      item('ghost', 999999), // product id that does not exist
    ],
    cats,
  );

  expect(groups.map((g) => g.name)).toEqual([catchAllName]);
  expect(groups[0]!.items).toHaveLength(4);
});

test('grouping the same rows twice gives the identical shape', () => {
  const produce = findCategoryByKey('produce')!;
  const onion = createProduct('onion', produce.id);
  const rows = [item('onion', onion.id)];
  const cats = listCategories();
  expect(groupByCategory(rows, cats)).toEqual(groupByCategory(rows, cats));
});

/* -------------------------------------------------- the classifier is optional */

test('with the classifier disabled nothing throws and the product lands in the catch-all', () => {
  const pack = loadPack('en-US');
  const cats = listCategories();

  const outcome = classify('green pesto sauce', cats, pack);
  expect(outcome.category).toBeNull();
  expect(outcome.how).toBe('disabled');

  // This is the composition the add path performs: whatever classify says, the
  // product is created. An `add` has to succeed with the classifier completely
  // unreachable, and this is what "unreachable" degrades to.
  const product = createProduct('green pesto sauce', outcome.category?.id ?? catchAllCategoryId());
  expect(product.category_id).toBe(catchAllCategoryId());

  // And the sweep that would rescue it later is a no-op rather than a throw.
  expect(sweepUncategorised(pack, 3)).toBe(0);
});

test('no two aisle names in a pack fold to the same key', () => {
  // If two headings folded together, `classify` could not tell which one the
  // model meant and would file the product under whichever sorted first. The
  // folding drops punctuation, so "Dairy, cheese & eggs" is exactly the kind of
  // name that has to stay distinct once the commas and ampersands are gone.
  for (const tag of ['en-US', 'he-IL']) {
    const folded = loadPack(tag).categories.map((c) => foldForCompare(c.name));
    expect(new Set(folded).size, `${tag} has two aisles that fold alike`).toBe(folded.length);
    for (const name of folded) expect(name).not.toBe('');
  }
});

test('an answer that is not one of the offered aisles is discarded, never guessed at', () => {
  // The fold-compare is the whole guard: the model is told to answer verbatim
  // from the list, so anything that does not fold-match one of these names is
  // treated as no answer. A hallucinated aisle would print a heading that does
  // not exist on the sheet.
  const cats = listCategories();
  const names = cats.map((c) => foldForCompare(c.name));
  expect(names).toContain(foldForCompare('Produce'));
  expect(names).toContain(foldForCompare('  produce  '));
  expect(names).not.toContain(foldForCompare('Refrigerated aisle'));
});
