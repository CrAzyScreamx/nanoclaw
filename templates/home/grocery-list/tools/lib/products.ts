/**
 * lib/products.ts — the product identity model.
 *
 * The list used to be a bag of strings. "zero" one week and "coca cola zero"
 * the next were two unrelated rows: two entries on one sheet, two lines in every
 * report, and no way to ask what this household actually buys every week. A
 * PRODUCT is the thing itself; the strings people type at it are aliases.
 *
 * WHAT IS STORED WHERE
 * --------------------
 * `products.name` is canonical — it is what the chat message and the printed
 * sheet show, no matter which phrasing was typed. `product_aliases` holds every
 * other phrasing that resolves to it. `items.product_id` is the link, and
 * `items.name` keeps a COPY of the canonical name as it stood when the item was
 * added.
 *
 * That copy is deliberate. Every render path, the `--n` position logic and the
 * in-week merge read `items.name`, and a join would put a later rename in a
 * position to rewrite a sheet that was already printed. A closed week keeps
 * saying what it said at the time; `products rename` reaches the open week only,
 * and only when asked.
 *
 * ONE FOLDING RULE, IN ONE PLACE
 * ------------------------------
 * `name_key` and `alias_key` both hold `foldForCompare()` from lib/categories.ts
 * — the same function `classify` matches an aisle name with. Two folding rules
 * would eventually disagree, and the disagreement would show up as a product
 * that resolves for the classifier and not for `add`. `UNIQUE` on both key
 * columns is what makes a phrasing resolve to exactly ONE product; that
 * guarantee is the feature, which is why aliases are a table and not a delimited
 * column.
 *
 * Candidate matching and the deferred-add token live next door in
 * lib/product-match.ts: this file is identity and storage, that one is "which
 * product might this be". The schema is owned by lib/bootstrap.ts, which runs
 * before any verb; nothing here creates a table.
 */
import { catchAllCategoryId, foldForCompare } from './categories.ts';
import { db } from './db.ts';
import { now } from './time.ts';
import type { ProductAliasRow, ProductRow } from './types.ts';

const SELECT_PRODUCT = 'SELECT id, name, name_key, category_id, created_at, retired_at FROM products';

/* -------------------------------------------------------------------- reads */

/** A product by its FOLDED key. Callers pass `foldForCompare(raw)`, not the raw text. */
export function findProductByNameKey(key: string, includeRetired = false): ProductRow | null {
  return (db()
    .query(`${SELECT_PRODUCT} WHERE name_key = $key${includeRetired ? '' : ' AND retired_at IS NULL'}`)
    .get({ $key: key }) as ProductRow) ?? null;
}

export function getProduct(id: number): ProductRow | null {
  return (db().query(`${SELECT_PRODUCT} WHERE id = $id`).get({ $id: id }) as ProductRow) ?? null;
}

/** Every phrasing taught for one product, for the operator surface. */
export function aliasesOf(productId: number): ProductAliasRow[] {
  return db()
    .query('SELECT * FROM product_aliases WHERE product_id = $id ORDER BY alias')
    .all({ $id: productId }) as ProductAliasRow[];
}

/** Every alias row. The candidate search in lib/product-match.ts walks these. */
export function listAliases(): ProductAliasRow[] {
  return db().query('SELECT * FROM product_aliases').all() as ProductAliasRow[];
}

/**
 * The product a typed name names OUTRIGHT — its canonical name or one of its
 * aliases, compared on the folded key.
 *
 * This is the rung that covers ordinary use, and it must stay a pure lookup: no
 * model, no scoring, no question. It is also why `addAliasFrom` matters so much
 * — a confirmed question is written back as an alias and the same phrasing lands
 * here forever after, so the group is asked exactly once.
 *
 * `includeRetired` answers a different question: "does anything at all already
 * own this phrasing", which is what the operator surface needs before it teaches
 * an alias. A retired product still owns its key until a merge releases it.
 */
export function findExact(
  raw: string,
  includeRetired = false,
): { product: ProductRow; via: 'name' | 'alias'; matched: string } | null {
  const key = foldForCompare(raw);
  if (!key) return null;

  const byName = findProductByNameKey(key, includeRetired);
  if (byName) return { product: byName, via: 'name', matched: byName.name };

  const alias = db()
    .query('SELECT * FROM product_aliases WHERE alias_key = $key')
    .get({ $key: key }) as ProductAliasRow | null;
  if (!alias) return null;

  const product = getProduct(alias.product_id);
  if (!product || (!includeRetired && product.retired_at)) return null;
  return { product, via: 'alias', matched: alias.alias };
}

/**
 * Products, alphabetically. `search` matches the folded form of a name or of any
 * alias, so looking for a product by a phrasing that was taught to it works.
 *
 * `includeRetired` is not in the contract's options object; it is additive and
 * exists because `products list --all` has to be able to show a product that was
 * merged away — a retired row is history, not a deletion.
 */
export function listProducts(opts?: {
  limit?: number;
  search?: string;
  includeRetired?: boolean;
}): ProductRow[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (!opts?.includeRetired) where.push('retired_at IS NULL');

  // Folded before it reaches LIKE, which also disarms it: `%` and `_` are
  // punctuation, so the folding has already turned any wildcard into a space.
  const search = opts?.search ? foldForCompare(opts.search) : '';
  if (search) {
    where.push(
      "(name_key LIKE '%' || $search || '%'" +
        " OR id IN (SELECT product_id FROM product_aliases WHERE alias_key LIKE '%' || $search || '%'))",
    );
    params.$search = search;
  }

  let sql = SELECT_PRODUCT;
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY name';
  if (opts?.limit != null && Number.isFinite(opts.limit)) {
    sql += ' LIMIT $limit';
    params.$limit = Math.max(0, Math.trunc(opts.limit));
  }
  return db().query(sql).all(params) as ProductRow[];
}

/**
 * Products sitting in the catch-all aisle with an id above `afterId` — the ones
 * `sweepUncategorised` gives another chance to. A product with no aisle at all
 * counts too; it prints under the catch-all either way.
 *
 * Ordered by id so the sweep walks them oldest-first and its cursor can advance
 * monotonically: without a high-water mark it would re-ask the model about every
 * product that legitimately BELONGS in the catch-all, on every invocation, for
 * ever. See lib/classify.ts for why the cursor advances only when the model was
 * actually reachable. `recategorise --all` passes 0 and takes the lot.
 */
export function uncategorisedProductsAfter(afterId: number, limit: number): ProductRow[] {
  const catchAll = catchAllCategoryId();
  return db()
    .query(
      `${SELECT_PRODUCT} WHERE retired_at IS NULL AND id > $after` +
        ' AND (category_id IS NULL OR category_id = $catch_all) ORDER BY id LIMIT $limit',
    )
    .all({ $after: afterId, $catch_all: catchAll, $limit: Math.max(0, Math.trunc(limit)) }) as ProductRow[];
}

/* ------------------------------------------------------------------- writes */

/**
 * Create a product, or return the existing one if this key is already taken.
 *
 * Never throws on a duplicate: two phrasings that fold to the same key are the
 * same product by definition, and `add` racing itself must not produce an error
 * the group would see.
 */
export function createProduct(name: string, categoryId: number): ProductRow {
  const key = foldForCompare(name);
  const existing = db().query(`${SELECT_PRODUCT} WHERE name_key = $key`).get({ $key: key }) as
    | ProductRow
    | null;
  if (existing) return existing;

  const info = db()
    .query(
      'INSERT INTO products (name, name_key, category_id, created_at)' +
        ' VALUES ($name, $name_key, $category_id, $created_at)',
    )
    .run({ $name: name.trim(), $name_key: key, $category_id: categoryId, $created_at: now() });
  return getProduct(Number(info.lastInsertRowid))!;
}

/** Move a product to another aisle. The single writer of `products.category_id`. */
export function setProductCategory(productId: number, categoryId: number): void {
  db()
    .query('UPDATE products SET category_id = $category_id WHERE id = $id')
    .run({ $category_id: categoryId, $id: productId });
}

/**
 * Teach a phrasing to a product, recording who taught it.
 *
 * REFUSES rather than steals: a key that already belongs to another product's
 * alias, or to any product's canonical name, is left alone. One phrasing, one
 * product, always — the whole point of the alias table. Returns whether a row
 * was actually written; call `findExact(raw, true)` first when the caller needs
 * to name the owner out loud.
 *
 * `source` is `user` for a phrasing the group confirmed, `model` for one the
 * classifier decided, `operator` for a hand-written one, and `rename` / `merge`
 * for the phrasing a product used to be called. Kept because "who taught this?"
 * is the first question asked of an alias that turns out to be wrong.
 */
export function addAliasFrom(productId: number, raw: string, source: string): boolean {
  const key = foldForCompare(raw);
  if (!key) return false;
  // Somebody's canonical name — including, harmlessly, this product's own.
  if (db().query('SELECT id FROM products WHERE name_key = $key').get({ $key: key })) return false;

  return (
    db()
      .query(
        'INSERT OR IGNORE INTO product_aliases (product_id, alias, alias_key, source, added_at)' +
          ' VALUES ($product_id, $alias, $alias_key, $source, $added_at)',
      )
      .run({
        $product_id: productId,
        $alias: raw.trim(),
        $alias_key: key,
        $source: source,
        $added_at: now(),
      }).changes > 0
  );
}

/** Unteach a phrasing. */
export function removeAlias(raw: string): boolean {
  const key = foldForCompare(raw);
  if (!key) return false;
  return (
    db().query('DELETE FROM product_aliases WHERE alias_key = $key').run({ $key: key }).changes > 0
  );
}

/**
 * Rename a product.
 *
 * The canonical name changes for everything printed from now on; already-stored
 * item names are rewritten only in `openWeekId`, and only when one is given — a
 * closed week keeps saying what it was shopped under. The old name becomes an
 * alias, so anyone still typing it resolves without being asked.
 *
 * Returns null when the product does not exist or the new name is already
 * another product's, rather than merging the two: folding two products together
 * is `mergeProducts`, and it must be an explicit decision.
 */
export function renameProduct(
  productId: number,
  name: string,
  openWeekId: number | null,
): { product: ProductRow; renamed_items: number } | null {
  const product = getProduct(productId);
  if (!product) return null;

  const key = foldForCompare(name);
  if (!key) return null;
  const clash = db()
    .query('SELECT id FROM products WHERE name_key = $key AND id != $id')
    .get({ $key: key, $id: productId });
  if (clash) return null;

  const oldName = product.name;
  db().query('UPDATE products SET name = $name, name_key = $key WHERE id = $id').run({
    $name: name.trim(),
    $key: key,
    $id: productId,
  });
  // The new name may have been an alias of this same product; it cannot be both.
  db().query('DELETE FROM product_aliases WHERE alias_key = $key').run({ $key: key });
  addAliasFrom(productId, oldName, 'rename');

  let renamed = 0;
  if (openWeekId != null) {
    renamed = db()
      .query(
        "UPDATE items SET name = $name WHERE product_id = $id AND week_id = $week_id AND status = 'pending'",
      )
      .run({ $name: name.trim(), $id: productId, $week_id: openWeekId }).changes;
  }
  return { product: getProduct(productId)!, renamed_items: renamed };
}

/**
 * Fold `fromId` into `intoId`: items repoint, aliases move, the loser's name
 * becomes an alias of the winner, and the loser is RETIRED rather than deleted
 * so every closed week keeps resolving.
 *
 * Pending items in the open week are rewritten to the winner's name and
 * collapsed if both products were on it — that is the whole point of a merge,
 * and leaving two identical lines on the sheet would defeat it. Closed weeks
 * keep the names they were shopped under.
 */
export function mergeProducts(
  fromId: number,
  intoId: number,
  openWeekId: number | null,
): { from: ProductRow; into: ProductRow; items: number; aliases: number; collapsed: number } | null {
  if (fromId === intoId) return null;
  const from = getProduct(fromId);
  const into = getProduct(intoId);
  if (!from || !into || into.retired_at) return null;

  const handle = db();
  let items = 0;
  let aliases = 0;
  let collapsed = 0;

  handle.transaction(() => {
    items = handle
      .query('UPDATE items SET product_id = $into WHERE product_id = $from')
      .run({ $into: intoId, $from: fromId }).changes;

    // OR IGNORE: an alias the winner already carries is simply dropped.
    aliases = handle
      .query('UPDATE OR IGNORE product_aliases SET product_id = $into WHERE product_id = $from')
      .run({ $into: intoId, $from: fromId }).changes;
    handle.query('DELETE FROM product_aliases WHERE product_id = $from').run({ $from: fromId });

    // Retiring RELEASES the key. A retired product must not keep owning the
    // phrasing it was known by: the winner needs it as an alias (that is what
    // makes the old name keep resolving after the merge), and leaving it parked
    // here would also let a later `createProduct` of the same name silently
    // resurrect this row instead of making a new one. The name itself is kept
    // for display; only the lookup key is tombstoned.
    handle
      .query(
        "UPDATE products SET retired_at = $at, name_key = '#retired:' || id || ':' || name_key WHERE id = $from",
      )
      .run({ $at: now(), $from: fromId });
    if (addAliasFrom(intoId, from.name, 'merge')) aliases++;

    if (openWeekId != null) {
      handle
        .query(
          "UPDATE items SET name = $name WHERE product_id = $id AND week_id = $week AND status = 'pending'",
        )
        .run({ $name: into.name, $id: intoId, $week: openWeekId });

      const rows = handle
        .query(
          "SELECT id, quantity, note FROM items WHERE product_id = $id AND week_id = $week AND status = 'pending' ORDER BY id",
        )
        .all({ $id: intoId, $week: openWeekId }) as {
        id: number;
        quantity: number | null;
        note: string | null;
      }[];
      if (rows.length > 1) {
        const [keep, ...rest] = rows;
        const qty = rows.reduce((n, r) => n + (r.quantity ?? 0), 0);
        const note = rows.map((r) => r.note).find((n) => n != null) ?? null;
        handle.query('UPDATE items SET quantity = $qty, note = COALESCE(note, $note) WHERE id = $id').run({
          $qty: qty,
          $note: note,
          $id: keep!.id,
        });
        for (const row of rest) {
          handle.query('DELETE FROM items WHERE id = $id').run({ $id: row.id });
          collapsed++;
        }
      }
    }
  })();

  return { from, into: getProduct(intoId)!, items, aliases, collapsed };
}
