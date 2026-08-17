/**
 * Product identity: the key, the aliases, and what may become a question.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * Two halves, and they pull in opposite directions on purpose.
 *
 *   PRECISION — a candidate costs a model call and possibly a question to the
 *   group, so a rule that fires on "red pepper" vs "yellow pepper" turns every
 *   add into an interrogation. `SAMPLE_NAMES` below is a representative Hebrew
 *   grocery corpus, and the leave-one-out sweep asserts a budget against it.
 *
 *   RECALL — the pairs the feature exists for ("zero" / "cola zero crate", two
 *   spellings of one cheese) must propose, or the model never gets asked and the
 *   list quietly grows two rows for one product.
 *
 * If you loosen a rule in `matchRule`, the sweep is what tells you what it cost.
 *
 * On the fixture below: it is Hebrew because it is DATA, not output — a corpus
 * carrying the shapes a grocery list actually produces (brands, plurals, spelling
 * variants, size words, near-identical flavours), which is what the precision
 * budget was measured against. Rewriting it into another language would keep the
 * test running and throw away the only reason to believe the number. The rules
 * under test know nothing about any language.
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

process.env.MARKET_HOME = mkdtempSync(join(tmpdir(), 'grocery-products-'));
process.env.MARKETY_CLASSIFY_DISABLED = '1';

const { db } = await import('../lib/db.ts');
const { bootstrap } = await import('../lib/bootstrap.ts');
const { writeConfig } = await import('../lib/locale.ts');
const { catchAllCategoryId, findCategoryByKey, foldForCompare } = await import('../lib/categories.ts');
const {
  addAliasFrom,
  aliasesOf,
  createProduct,
  findExact,
  findProductByNameKey,
  getProduct,
  listProducts,
  mergeProducts,
  removeAlias,
  renameProduct,
  setProductCategory,
  uncategorisedProductsAfter,
} = await import('../lib/products.ts');
const { editDistance, matchRule, searchCandidateMatches, searchCandidates } = await import(
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

/** A product in the catch-all aisle — where anything unclassified lives. */
function product(name: string) {
  return createProduct(name, catchAllCategoryId());
}

/** A representative Hebrew grocery corpus: brands, plurals, spellings, sizes. */
const SAMPLE_NAMES = [
  'אבוקדו', 'אבטיח', 'אפרסק', 'אפרסקים', 'אצבעות אנטריקוט', 'אקונומיקה', 'בטטה', 'בייגלה',
  'ביצים', 'בירה', 'במבה נוגט', 'בצל', 'בצל יבש', 'בצל ירוק', 'בצל סגול', 'גבינה לבנה סקי',
  'גבינה סקי', 'גבינה צהובה', 'גבינת סקי', 'גזר', 'דג סלמון', 'דייאט ספרייט', 'וופל', 'זירו',
  'חזה עוף', 'חלב יוטבתה', 'חלב מועשר יטבתה', 'חלב סויה וניל', 'חסה', 'חצילים', 'טונה',
  'יין לקידוש', 'כוסברה', 'כפיות חד פעמיות', 'כרוב לבן', 'לחם דגנים', 'לימונים', 'מגבות נייר',
  'מגנום מנגו', 'מגנום תות', 'מיונז', 'מיץ ענבים', 'מלון', 'מלפפון', 'מלפפון ירוק', 'מלפפונים',
  'מנגו', 'מסטיקים', 'מרכך לשיער', 'משחת שיניים', 'מתליות', 'מתקן כביסה מתכת',
  'נוזל כביסה בייבי', 'נוזל כלים ספארק', 'ניילון לשולחן', 'נייר מטבח', 'סבון כיף', 'סבון כלים',
  'סבון לידיים', 'עגבניות שרי', 'עלית הארץ', 'ענבים אדומים', 'ענבים לבנים', 'פטריות', 'פיתות',
  'פלפל אדום', 'פלפל חריף', 'פלפל ירוק', 'פלפל כתום', 'פלפל צהוב', 'פסטה צינורות',
  'פרוסות גבינה', 'פתיתים', "צ'יפס", 'ציפס', 'צנוניות', "קוטג'", 'קולה זירו קרטון', 'קוקה קולה',
  'רוקט', 'שזיף אדום', 'שמן קנולה', 'שמנת חמוצה תנובה', 'שמנת לבישול', 'שניצל תירס',
  'שקיות אוכל', 'תבניות חד פעמיות בינוניות', 'תבניות חד פעמיות בינוניות קטנות',
  'תבניות חד פעמיות גדולות', 'תבניות חד פעמיות קטנות', 'תירס', 'תפוח אדמה', 'תפוח אדמה לבן',
];

/** Fill the product table with a name list, skipping one. */
function fill(names: string[], skip?: string): void {
  for (const name of names) if (name !== skip) product(name);
}

/** Empty the product tables without re-seeding the aisles — the sweep below runs 90 times. */
function clearProducts(): void {
  const handle = db();
  handle.exec('PRAGMA foreign_keys = OFF');
  handle.exec('DELETE FROM product_aliases');
  handle.exec('DELETE FROM products');
  handle.exec('PRAGMA foreign_keys = ON');
}

/* --------------------------------------------------------------- the key */

test('the key folds punctuation and case, so one phrasing is one product', () => {
  expect(foldForCompare("צ'יפס")).toBe(foldForCompare('ציפס'));
  expect(foldForCompare('  Coca-Cola  ')).toBe(foldForCompare('coca cola'));

  const first = product("צ'יפס");
  const second = product('ציפס');
  expect(second.id).toBe(first.id);
  expect(listProducts()).toHaveLength(1);
});

test('findProductByNameKey takes a folded key, findExact takes what was typed', () => {
  const cola = product('coca cola zero');
  expect(findProductByNameKey(foldForCompare('COCA  COLA  ZERO'))!.id).toBe(cola.id);
  expect(findExact('coca cola zero')!.via).toBe('name');
  expect(findExact('nothing like it')).toBeNull();
});

/**
 * The invariant the 2026-08-16 folding change broke: a name is an exact hit on
 * itself.
 *
 * It reads as too trivial to test, which is why it went unnoticed. `foldForCompare`
 * builds the STORED key as well as the lookup key, so when the positional fold was
 * dropped, every key already in the database was in one folding and every freshly
 * typed name in another. A product could not be found by its own name: two final
 * letters (`סבון כלים`) proposed nothing and made a duplicate, one (`פלפל אדום`)
 * matched itself by the spelling rule and asked the group whether `פלפל אדום` was
 * the same product as `פלפל אדום`.
 *
 * These cases are Hebrew because Hebrew is where positional forms are, but the
 * property is not: any fold that treats stored and typed names differently fails
 * this test, whatever the script.
 */
test('a name is an exact hit on itself, however its letters are positioned', () => {
  for (const name of ['פלפל אדום', 'סבון כלים', 'חזה עוף', 'לחם', 'מלפפונים', 'milk']) {
    const created = product(name);
    const found = findExact(name);
    expect(found, `"${name}" could not be found by its own name`).not.toBeNull();
    expect(found!.product.id).toBe(created.id);
    expect(found!.via).toBe('name');
  }
  // One product each — not a duplicate anywhere.
  expect(listProducts()).toHaveLength(6);
});

test('a Hebrew plural reaches the product it inflects, and only that one', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;

  // What the fold buys: the stem now reaches its own plural, so the pair becomes
  // a candidate the model can be asked about instead of a silent second product.
  expect(rule('מלפפון', 'מלפפונים')).toBe('substring');
  expect(rule('לימון', 'לימונים')).toBe('substring');

  // What it must not buy: the pairs the one-edit cap exists to keep apart are all
  // final-letter words, so this is exactly where a looser fold would show up.
  expect(rule('פלפל אדום', 'פלפל כתום')).toBeNull();
  expect(rule('סבון כלים', 'סבון כיף')).toBeNull();
  expect(rule('מיונז', 'מלון')).toBeNull();
});

/* ------------------------------------------------------------- the aliases */

test('an alias resolves exactly like a canonical name', () => {
  const cola = product('coca cola zero');
  addAliasFrom(cola.id, 'zero', 'user');

  const hit = findExact('zero')!;
  expect(hit.via).toBe('alias');
  expect(hit.matched).toBe('zero');
  expect(hit.product.id).toBe(cola.id);
});

test('one phrasing belongs to one product — addAlias refuses, never steals', () => {
  const cola = product('coca cola zero');
  const sprite = product('sprite zero');
  addAliasFrom(cola.id, 'zero', 'user');
  addAliasFrom(sprite.id, 'zero', 'user');

  expect(findExact('zero')!.product.id).toBe(cola.id);
  expect(aliasesOf(sprite.id)).toHaveLength(0);
  // The operator surface asks first, so it can say WHY nothing happened.
  expect(findExact('zero', true)!.product.id).toBe(cola.id);
});

test('an alias may not shadow another product’s canonical name', () => {
  const mango = product('mango');
  const bar = product('magnum mango');
  expect(addAliasFrom(bar.id, 'mango', 'operator')).toBe(false);
  expect(findExact('mango')!.product.id).toBe(mango.id);
});

test('removeAlias unteaches a phrasing', () => {
  const cola = product('coca cola zero');
  addAliasFrom(cola.id, 'zero', 'user');
  expect(removeAlias('zero')).toBe(true);
  expect(findExact('zero')).toBeNull();
});

/* --------------------------------------------------------------- matching */

test('the pairs the feature exists for', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;
  expect(rule('זירו', 'קולה זירו קרטון')).toBe('substring');
  expect(rule('גבינה סקי', 'גבינה לבנה סקי')).toBe('subset');
  expect(rule('גבינת סקי', 'גבינה סקי')).toBe('spelling');
  expect(rule('אפרסק', 'אפרסקים')).toBe('substring');
  // The same three rules, in a language with different word shapes.
  expect(rule('zero', 'cola zero crate')).toBe('substring');
  expect(rule('ski cheese', 'ski white cheese')).toBe('subset');
  expect(rule('yoghurt', 'yogurt')).toBe('spelling');
});

test('a shared word is NOT a match — that would be the whole aisle', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;
  expect(rule('פלפל אדום', 'פלפל צהוב')).toBeNull();
  expect(rule('סבון כלים', 'סבון לידיים')).toBeNull();
  expect(rule('ענבים אדומים', 'ענבים לבנים')).toBeNull();
  expect(rule('מגנום מנגו', 'מגנום תות')).toBeNull();
  expect(rule('red pepper', 'green pepper')).toBeNull();
});

test('two edits is a different product, not a misspelling', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;
  // Every one of these is exactly two edits apart and none is the same thing.
  // They are why the spelling rule caps at one edit.
  expect(rule('פלפל אדום', 'פלפל כתום')).toBeNull();
  expect(rule('סבון כלים', 'סבון כיף')).toBeNull();
  expect(rule('מיונז', 'מלון')).toBeNull();
});

test('sizes stay apart even when one name contains the other words', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;
  expect(rule('תבניות חד פעמיות גדולות', 'תבניות חד פעמיות קטנות')).toBeNull();
  expect(rule('תבניות חד פעמיות בינוניות', 'תבניות חד פעמיות קטנות')).toBeNull();
});

test('a short name is not a spelling variant of another short name', () => {
  const rule = (a: string, b: string) => matchRule(foldForCompare(a), foldForCompare(b))?.how ?? null;
  expect(rule('תות', 'תירס')).toBeNull();
  expect(rule('מנגו', 'מלון')).toBeNull();
});

test('an identical folded key is not a candidate — it is an exact hit', () => {
  expect(matchRule(foldForCompare("צ'יפס"), foldForCompare('ציפס'))).toBeNull();
});

test('editDistance abandons past the cap instead of running to the end', () => {
  expect(editDistance('גבינה סקי', 'גבינת סקי')).toBe(1);
  expect(editDistance('abc', 'abc')).toBe(0);
  expect(editDistance('abcdefgh', 'zzzzzzzz', 2)).toBe(3); // cap + 1, not 8
});

/* ------------------------------------------------------------- candidates */

test('the motivating case proposes the right product', () => {
  fill(SAMPLE_NAMES);
  const found = searchCandidates('זירו קרטון');
  expect(found.map((p) => p.name)).toContain('קולה זירו קרטון');
});

test('a name already on file proposes nothing about its lookalikes', () => {
  fill(SAMPLE_NAMES);
  expect(findExact('פלפל אדום')!.product.name).toBe('פלפל אדום');
  expect(searchCandidates('פלפל אדום').map((p) => p.name)).not.toContain('פלפל צהוב');
});

test('aliases are searched, not just canonical names', () => {
  const cola = product('קוקה קולה');
  addAliasFrom(cola.id, 'קוקה קולה זירו', 'user');

  // Nothing about the canonical name matches "קולה זירו"; the learned phrasing
  // is the only thing that can surface this product.
  const found = searchCandidateMatches('קולה זירו');
  expect(found.map((c) => c.product.id)).toContain(cola.id);
  expect(found[0]!.via).toBe('alias');
  expect(found[0]!.matched).toBe('קוקה קולה זירו');
  // The contracted form is the same search with the context stripped off.
  expect(searchCandidates('קולה זירו').map((p) => p.id)).toEqual(found.map((c) => c.product.id));
});

test('a brand new name proposes nothing at all', () => {
  fill(SAMPLE_NAMES);
  expect(searchCandidates('מברג פיליפס')).toHaveLength(0);
  expect(searchCandidates('נרות שבת')).toHaveLength(0);
});

test('candidates are capped at four and ordered best first', () => {
  fill(SAMPLE_NAMES);
  const found = searchCandidateMatches('תבניות חד פעמיות בינוניות קטנות מאוד');
  expect(found.length).toBeLessThanOrEqual(4);
  for (let i = 1; i < found.length; i++) {
    expect(found[i - 1]!.score).toBeGreaterThanOrEqual(found[i]!.score);
  }
});

test('re-typing a name already on file costs nothing at all', () => {
  fill(SAMPLE_NAMES);
  // The property that matters day to day: `add` tries findExact first, so a
  // known name never reaches the matcher, never calls the model and never asks
  // the group — however many lookalikes are on file.
  for (const name of SAMPLE_NAMES) expect(findExact(name)).not.toBeNull();
});

/**
 * The guard rail, and the expensive one. For each name in the corpus, fill the table from
 * every OTHER name and then type it — that is a first sighting, the only
 * situation in which the matcher runs at all.
 *
 * The bound is a budget, not a target: each name over it is one model call the
 * first time that phrasing is ever used, and at most one question to the group.
 * Every name it catches is a pair a person would also look twice at. If a change
 * to `matchRule` pushes this up, the diff is telling you what the new rule
 * dragged in — go read it before raising the number.
 */
test('a first sighting rarely needs the model', () => {
  const asked: string[] = [];
  for (const held of SAMPLE_NAMES) {
    clearProducts();
    fill(SAMPLE_NAMES, held);
    // A name whose folded twin is still on file is an exact hit, not a first
    // sighting — "ציפס" while "צ'יפס" is present.
    if (!findExact(held) && searchCandidates(held).length > 0) asked.push(held);
  }
  expect(asked.length).toBeLessThanOrEqual(25);
});

/* ------------------------------------------------------------------ writes */

test('listProducts searches names and aliases, and can include retired rows', () => {
  const cola = product('coca cola zero');
  addAliasFrom(cola.id, 'zero', 'user');
  product('sparkling water');

  expect(listProducts({ search: 'zero' }).map((p) => p.id)).toEqual([cola.id]);
  expect(listProducts({ search: 'water' }).map((p) => p.name)).toEqual(['sparkling water']);
  expect(listProducts({ limit: 1 })).toHaveLength(1);
});

test('a retired product never resolves or proposes, but history keeps it', () => {
  const keep = product('coca cola zero');
  const gone = product('zero');
  mergeProducts(gone.id, keep.id, null);

  expect(findExact('zero')!.product.id).toBe(keep.id); // via the merge alias
  expect(listProducts()).toHaveLength(1);
  expect(listProducts({ includeRetired: true })).toHaveLength(2);
  expect(getProduct(gone.id)!.retired_at).not.toBeNull();
});

test('uncategorised products are the ones sitting in the catch-all', () => {
  const bakery = findCategoryByKey('bakery')!;
  const parked = product('green pesto sauce');
  const filed = product('bread');
  setProductCategory(filed.id, bakery.id);

  const waiting = uncategorisedProductsAfter(0, 10);
  expect(waiting.map((p) => p.id)).toEqual([parked.id]);
});

/* ------------------------------------------------------------------ rename */

test('rename keeps the old name resolving and leaves closed weeks alone', () => {
  const zero = product('zero');
  db()
    .query("INSERT INTO weeks (week_start, opened_at, status) VALUES ('2026-08-05', '2026-08-05', 'closed')")
    .run();
  db()
    .query("INSERT INTO weeks (week_start, opened_at, status) VALUES ('2026-08-12', '2026-08-12', 'open')")
    .run();
  const insert = db().query(
    "INSERT INTO items (week_id, name, status, added_at, product_id) VALUES ($w, $n, $s, '2026-08-05', $p)",
  );
  insert.run({ $w: 1, $n: 'zero', $s: 'bought', $p: zero.id });
  insert.run({ $w: 2, $n: 'zero', $s: 'pending', $p: zero.id });

  const done = renameProduct(zero.id, 'coca cola zero', 2)!;
  expect(done.product.name).toBe('coca cola zero');
  expect(done.renamed_items).toBe(1);
  expect(findExact('zero')!.product.id).toBe(zero.id);

  const rows = db().query('SELECT week_id, name FROM items ORDER BY week_id').all() as {
    week_id: number;
    name: string;
  }[];
  expect(rows[0]!.name).toBe('zero'); // the closed week is history
  expect(rows[1]!.name).toBe('coca cola zero');
});

test('renaming onto a name another product owns is refused', () => {
  const mango = product('mango');
  product('magnum mango');
  expect(renameProduct(mango.id, 'magnum mango', null)).toBeNull();
  expect(getProduct(mango.id)!.name).toBe('mango');
});

/* ------------------------------------------------------------------- merge */

test('merge repoints items, keeps the loser as an alias, and collapses the open week', () => {
  const keep = product('coca cola zero');
  const gone = product('zero');
  db()
    .query("INSERT INTO weeks (week_start, opened_at, status) VALUES ('2026-08-12', '2026-08-12', 'open')")
    .run();
  const insert = db().query(
    "INSERT INTO items (week_id, name, quantity, status, added_at, product_id) VALUES (1, $n, $q, 'pending', '2026-08-12', $p)",
  );
  insert.run({ $n: 'coca cola zero', $q: 2, $p: keep.id });
  insert.run({ $n: 'zero', $q: 3, $p: gone.id });

  const done = mergeProducts(gone.id, keep.id, 1)!;
  expect(done.items).toBe(1);
  expect(done.collapsed).toBe(1);
  expect(aliasesOf(keep.id).map((a) => a.alias)).toContain('zero');

  const open = db().query("SELECT name, quantity FROM items WHERE status = 'pending'").all() as {
    name: string;
    quantity: number;
  }[];
  expect(open).toHaveLength(1);
  expect(open[0]!.name).toBe('coca cola zero');
  expect(open[0]!.quantity).toBe(5);
});

test('merging a product into itself is refused', () => {
  const keep = product('coca cola zero');
  expect(mergeProducts(keep.id, keep.id, null)).toBeNull();
});
