/**
 * lib/categories.ts — the aisles, and the one folding rule this tool has.
 *
 * A new product's aisle is decided once, by the model (lib/classify.ts), and
 * stored. There is no word-stem matcher, because a stem list is a fact about one
 * language and a second language could not be added by translating it — adding a
 * language here is one JSON file in `locales/` and no code at all.
 *
 * The cost is worth naming: aisle resolution needs a model call for each new
 * product. Three things pay that back — it is once per PRODUCT and never per
 * purchase, a product whose classification failed still lands on the sheet under
 * the catch-all, and `bootstrap`'s bounded sweep retries those later.
 *
 * WHY THE AISLE IS STORED RATHER THAN RECOMPUTED
 * ---------------------------------------------
 * Because it is not a pure function of the name: a model is not guaranteed to
 * answer the same way twice, and recomputing at print time would let the same
 * list come out sorted differently on two consecutive prints. That was the
 * property the deterministic version existed to protect, and it survives here.
 * `grocery.ts recategorise` is what buys back the ability to fix a stored answer.
 *
 * OWNERSHIP
 * ---------
 * `products.category_id` is the ONLY owner of an aisle. `items` has no
 * `category_id`: storing it in both places let the two disagree, and an item
 * added before a `recategorise` kept printing under the old heading forever.
 * Every read resolves through `items → products → categories`, which is what
 * `groupByCategory` below does.
 *
 * The table is seeded from the active locale pack and is READ-ONLY to the agent.
 * There is no verb that adds a category, deliberately: the eleven aisles are a
 * judgement about how a physical shop is walked, and a list whose headings drift
 * is a list nobody can shop from top to bottom.
 */
import { db } from './db.ts';
import { ExitCode, GroceryError } from './errors.ts';
import type { LocalePack } from './locale.ts';
import type { CategoryRow } from './types.ts';

/* ------------------------------------------------------------------ folding */

/**
 * Letters whose shape depends on where in the word they sit, folded to one form.
 *
 * Hebrew's five final forms are the whole table today: `מ` is written `ם` at the
 * end of a word and nowhere else. That is **one letter with two shapes, chosen by
 * position** — which is what letter case is in Latin, and it belongs in the same
 * step as `toLowerCase` for the same reason.
 *
 * It is load-bearing rather than cosmetic, because Hebrew inflects by SUFFIX.
 * Every plural, construct and possessive pushes the final letter into the middle
 * of the word and re-spells it: `מלפפון` → `מלפפונים` turns the ן into a נ. Left
 * unfolded the two share no substring and sit two edits apart — outside every
 * rule in lib/product-match.ts — so a plural cannot be recognised as the word it
 * inflects. Folded, `מלפפונ` is a plain prefix of `מלפפונימ`.
 *
 * This is a fixed table applied to every input, NOT a branch on the configured
 * language: a name is folded the same way whichever pack is active, which is what
 * lets `config --locale` stay a rename of eleven aisle strings. Another script
 * with positional forms gets an entry here; nothing else changes.
 */
const POSITIONAL_FORMS: Record<string, string> = {
  'ך': 'כ',
  'ם': 'מ',
  'ן': 'נ',
  'ף': 'פ',
  'ץ': 'צ',
};

/**
 * Fold a string to a comparison key: NFKC, lower-cased, positional letter forms
 * normalised, diacritics and punctuation removed, whitespace collapsed, trimmed.
 *
 * **Locale-neutral, and it has to stay that way.** Nothing here branches on the
 * configured language: `\p{M}` strips Hebrew niqqud, Arabic harakat and Latin
 * accents with one rule; case-folding uses `toLowerCase` rather than
 * `toLocaleLowerCase` precisely so the answer does not depend on which language
 * the container happens to be running in; and `POSITIONAL_FORMS` is one table
 * applied unconditionally. Locale-neutral means *the active pack cannot change
 * the answer* — it does not mean the function may know nothing about how any
 * alphabet spells a letter, and a fold that refuses to know that cannot match a
 * Hebrew plural at all.
 *
 * Two jobs, one rule: `lib/classify.ts` fold-compares the model's verbatim
 * answer against the pack's aisle names, and `lib/products.ts` builds `name_key`
 * and `alias_key` from it so one phrasing resolves to exactly one product.
 *
 * **Because it builds stored keys, editing this function is a DATA MIGRATION.**
 * Every `products.name_key` and `product_aliases.alias_key` was written by
 * whichever version was current at the time, so a change here leaves stored keys
 * in one folding and freshly typed names in another. That is not a subtle drift:
 * `findExact` stops matching a product against its own name, and `add` then makes
 * a duplicate. It happened — the positional fold was briefly dropped on
 * 2026-08-16, and typing `סבון כלים` created a second `סבון כלים` while typing
 * `פלפל אדום` asked the group whether it was the same product as `פלפל אדום`.
 * Any future edit needs a re-key pass over both tables, with collision handling.
 *
 * The apostrophe family is DELETED rather than turned into a space, while every
 * other punctuation mark becomes a space. That asymmetry is deliberate and it is
 * script-neutral: an apostrophe sits inside a word in every language that uses
 * one ("קוטג'" → "קוטג", "it's" → "its", and the Hebrew geresh in "צ'יפס" /
 * "ציפס" folding to a single key), while a hyphen or a slash separates words
 * ("coca-cola" and "coca cola" folding together).
 */
export function foldForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    // Positional letter forms, on the same footing as case — see above.
    .replace(/[ךםןףץ]/gu, (letter) => POSITIONAL_FORMS[letter]!)
    // Apostrophes, quotes, the Hebrew geresh and gershayim: intra-word, dropped.
    .replace(/['"‘’‚‛“”„‟´`׳״]/gu, '')
    // Diacritics: decompose, drop every combining mark, recompose what is left.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    // Everything else that is punctuation or a symbol separates words.
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/* ------------------------------------------------------------------ seeding */

/**
 * Bring the `categories` table into line with the active locale pack.
 *
 * Insert-missing and update display names, sort order and the catch-all flag.
 * **It never deletes.** A category the pack no longer lists keeps its row, so
 * every product filed under it keeps resolving and no closed week loses a
 * heading — a pack edit must never orphan history.
 *
 * Matching is on `key`, never on the display name. That is what makes switching
 * language a rename in place: `config --locale he-IL` rewrites eleven strings
 * and leaves every product, every item and every closed week exactly where it
 * was. Matching on the name would instead create eleven new aisles and strand
 * the products in the old ones.
 *
 * Called by `bootstrap()` on every invocation and by `config --locale`. Both are
 * idempotent; running it twice changes nothing.
 */
export function seedCategories(pack: LocalePack): void {
  const handle = db();
  const insert = handle.query(
    'INSERT INTO categories (key, name, sort_order, is_catch_all) VALUES ($key, $name, $sort_order, $is_catch_all)',
  );
  const update = handle.query(
    'UPDATE categories SET name = $name, sort_order = $sort_order, is_catch_all = $is_catch_all WHERE key = $key',
  );
  const find = handle.query('SELECT id FROM categories WHERE key = $key');

  const catchAllKey = (pack.categories.find((c) => c.catchAll) ?? pack.categories[pack.categories.length - 1])?.key;

  handle.transaction(() => {
    for (const category of pack.categories) {
      const isCatchAll = category.key === catchAllKey ? 1 : 0;
      const params = {
        $key: category.key,
        $name: category.name,
        $sort_order: category.sort,
        $is_catch_all: isCatchAll,
      };
      if (find.get({ $key: category.key })) update.run(params);
      else insert.run(params);
    }
    // Exactly one catch-all, always. A row left over from an older pack could
    // otherwise keep the flag and give `catchAllCategoryId()` two answers.
    if (catchAllKey !== undefined) {
      handle
        .query('UPDATE categories SET is_catch_all = 0 WHERE key != $key AND is_catch_all = 1')
        .run({ $key: catchAllKey });
    }
  })();
}

/* ---------------------------------------------------------------- accessors */

/** Every aisle in print order — the order the sheet's headings appear in. */
export function listCategories(): CategoryRow[] {
  return db()
    .query('SELECT id, key, name, sort_order, is_catch_all FROM categories ORDER BY sort_order, id')
    .all() as CategoryRow[];
}

/**
 * The catch-all aisle's id — where a product goes when the classifier could not
 * be reached, or answered with something that is not an aisle.
 *
 * It is a DESTINATION, never a match: nothing is ever classified INTO it by
 * comparison, only filed there when nothing else is known. Landing there is a
 * normal outcome and not a failure — the product still prints, still gets
 * bought, and `bootstrap`'s sweep gives it another chance later.
 */
export function catchAllCategoryId(): number {
  const flagged = db()
    .query('SELECT id FROM categories WHERE is_catch_all = 1 ORDER BY sort_order DESC, id DESC')
    .get() as { id: number } | null;
  if (flagged) return flagged.id;

  // No flag anywhere: fall back to whatever sorts last, which is where the pack
  // puts the catch-all. Better a heading at the bottom of the sheet than a throw
  // on the `add` path.
  const last = db().query('SELECT id FROM categories ORDER BY sort_order DESC, id DESC').get() as
    | { id: number }
    | null;
  if (last) return last.id;

  throw new GroceryError('No aisles exist yet — the category table has not been seeded.', {
    code: 'categories_unseeded',
    exitCode: ExitCode.UNEXPECTED,
    hint: 'bootstrap() seeds them from the active locale pack on every run; run any verb once.',
  });
}

export function getCategory(id: number): CategoryRow | null {
  return (db()
    .query('SELECT id, key, name, sort_order, is_catch_all FROM categories WHERE id = $id')
    .get({ $id: id }) as CategoryRow) ?? null;
}

/**
 * An aisle by its pack key (`produce`, `bakery`, …).
 *
 * The key is the stable identifier and the display name is not: `recategorise
 * --category produce` keeps working after the group switches language, where
 * `--category Produce` would stop the moment the aisle is called something else.
 */
export function findCategoryByKey(key: string): CategoryRow | null {
  return (db()
    .query('SELECT id, key, name, sort_order, is_catch_all FROM categories WHERE key = $key')
    .get({ $key: key.trim() }) as CategoryRow) ?? null;
}

/* ----------------------------------------------------------------- grouping */

/**
 * Group items under aisle headings for the sheet, resolving each item's aisle
 * through `items → products → categories`.
 *
 * Ordered by `sort_order` with the catch-all last, empty aisles omitted, and
 * input order preserved inside an aisle — which is DB id order, so the printed
 * sheet lists items in the same order as the numbered chat message. An item is
 * NEVER dropped: no product, a product with no aisle, or an aisle id that no
 * longer exists all land in the catch-all.
 *
 * The product→aisle map is read straight from the DB rather than taken from a
 * `products.ts` import, so this file stays a leaf: `lib/products.ts` needs the
 * catch-all id from here, and importing back the other way would make the two
 * modules circular for no gain.
 *
 * The type parameter is `product_id: number | null` because that is what
 * `ItemRow` actually carries: an item whose product row was deleted keeps its
 * place on the list. Anything satisfying the narrower non-null shape satisfies
 * this one too, so callers lose nothing by the widening.
 */
export function groupByCategory<T extends { product_id: number | null }>(
  items: T[],
  cats: CategoryRow[],
): { name: string; items: T[] }[] {
  if (items.length === 0 || cats.length === 0) return [];

  const byId = new Map(cats.map((c) => [c.id, c]));
  const fallback = cats.find((c) => c.is_catch_all === 1) ?? cats[cats.length - 1]!;

  const aisleOfProduct = new Map<number, number | null>();
  for (const row of db().query('SELECT id, category_id FROM products').all() as {
    id: number;
    category_id: number | null;
  }[]) {
    aisleOfProduct.set(row.id, row.category_id);
  }

  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const categoryId = item.product_id != null ? (aisleOfProduct.get(item.product_id) ?? null) : null;
    const category = (categoryId != null ? byId.get(categoryId) : undefined) ?? fallback;
    const bucket = buckets.get(category.id);
    if (bucket) bucket.push(item);
    else buckets.set(category.id, [item]);
  }

  return [...cats]
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .filter((c) => buckets.has(c.id))
    .map((c) => ({ name: c.name, items: buckets.get(c.id)! }));
}
