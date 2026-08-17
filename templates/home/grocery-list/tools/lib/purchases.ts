/**
 * Product identity, and writing one purchase of a product into a week.
 *
 * `lib/products.ts` owns the table, the aliases and the string candidates;
 * `lib/product-match.ts` owns the candidate search and the deferred-add token.
 * This is the decision layer above both — what a typed name MEANS, and what
 * `add` does once it knows.
 *
 * THE AISLE IS RESOLVED THROUGH THE PRODUCT
 * -----------------------------------------
 * `items` has no `category_id`: an item's aisle is `items → products →
 * categories`, resolved at read time from the single owner. Stored on the
 * PRODUCT rather than recomputed at print time, because a model is not
 * guaranteed to answer the same way twice and the same list would otherwise sort
 * two ways on two consecutive sheets.
 */
import { catchAllCategoryId, foldForCompare, getCategory, listCategories } from './categories.ts';
import { classify, judgeProduct } from './classify.ts';
import { db } from './db.ts';
import type { LocalePack } from './locale.ts';
import { searchCandidateMatches, type Candidate } from './product-match.ts';
import { createProduct, findExact } from './products.ts';
import { now } from './time.ts';
import type { ItemRow, ProductRow, WeekRow } from './types.ts';

/**
 * What a typed name means, on a ladder ordered by cost.
 *
 * `exact` is a key lookup and covers ordinary use for free. Only a miss reaches
 * the string rules, and only what they propose reaches the model.
 *
 * The two ways the model can decline are NOT the same. "None of these" actively
 * rules the candidates out, so a new product is right and the user is never
 * bothered. A model that could not be REACHED has ruled out nothing, so the
 * string candidates still stand and the question goes to the user. The feature
 * degrades to asking more often, never to guessing.
 */
export type Identity =
  | { kind: 'exact'; product: ProductRow; via: 'name' | 'alias'; matched: string }
  | { kind: 'candidates'; candidates: Candidate[]; judged: string }
  | { kind: 'new'; judged: string };

/** How a candidate is offered to the model — the alias is what actually matched. */
function candidateLabel(candidate: Candidate): string {
  return candidate.via === 'alias' ? `${candidate.product.name} (${candidate.matched})` : candidate.product.name;
}

export function identify(raw: string, pack: LocalePack): Identity {
  // The exact rung: a canonical name OR a learned alias, on the folded key. An
  // alias is the whole reason a phrasing asked about once is never asked about
  // again, so a lookup that skipped them would re-ask the same question forever
  // — which is why this uses `findExact` and not the contract's bare
  // `findProductByNameKey`, which sees canonical names alone.
  const exact = findExact(raw);
  if (exact) return { kind: 'exact', ...exact };

  const found = searchCandidateMatches(raw);
  if (found.length === 0) return { kind: 'new', judged: 'no-candidates' };

  const verdict = judgeProduct(raw, found.map(candidateLabel), pack);
  // `choice` is an INDEX into the options that were offered, not a product id.
  if (verdict.choice != null && found[verdict.choice]) {
    return { kind: 'candidates', candidates: [found[verdict.choice]!], judged: verdict.how };
  }
  // Only a model that actually answered can rule the candidates out. Every
  // other `how` (cooldown, transport, auth, unusable) means nobody judged them.
  if (verdict.how === 'model') return { kind: 'new', judged: 'model-ruled-out' };
  return { kind: 'candidates', candidates: found, judged: verdict.how };
}

/** What one `add` did to the week. `renderConfirm` turns this into a reply. */
export interface PurchaseResult {
  action: 'added' | 'merged';
  item: ItemRow;
  /**
   * What THIS call contributed, which the stored row cannot tell you after the
   * fact — the confirmation says "(2) — now 5" and only the caller ever knew
   * the 2. `null` means no `--qty` was passed, so nothing was added and this
   * was a note or unit correction rather than a purchase.
   */
  added: number | null;
}

/** A `PurchaseResult` plus whether this add is what created the product. */
export type AddResult = PurchaseResult & { isNewProduct: boolean };

/**
 * Record one purchase of a product in a week.
 *
 * The item's name is the PRODUCT's name, not the words that were typed — that
 * is what makes "zero" and "Coca-Cola Zero" one line on the sheet instead of
 * two. Merging is on product identity for the same reason.
 *
 * MERGE SEMANTICS, WHICH ARE LOAD-BEARING
 * ---------------------------------------
 *   --qty            ADDS to the stored count.
 *   --unit / --note  OVERWRITE, but only when actually passed.
 *   a bought row     never merges — it gets a fresh row, because it was
 *                    genuinely bought and asking for it again is a new request.
 */
export function addPurchase(
  week: WeekRow,
  product: ProductRow,
  qty: number | null,
  unit: string | null,
  note: string | null,
): PurchaseResult {
  const pending = db()
    .query("SELECT * FROM items WHERE week_id = $week_id AND status = 'pending'")
    .all({ $week_id: week.id }) as ItemRow[];
  // Product identity first. The name comparison is belt and braces: every row
  // this tool writes carries a `product_id`, and a row that somehow does not
  // must still not be duplicated.
  const dup = pending.find((it) =>
    it.product_id != null
      ? it.product_id === product.id
      : foldForCompare(it.name) === foldForCompare(product.name),
  );

  if (dup) {
    const merged = qty != null ? (dup.quantity ?? 0) + qty : dup.quantity;
    db().query(
      'UPDATE items SET quantity = $quantity, unit = COALESCE($unit, unit), note = COALESCE($note, note), product_id = $product_id WHERE id = $id',
    ).run({ $quantity: merged, $unit: unit, $note: note, $product_id: product.id, $id: dup.id });
    return {
      action: 'merged',
      item: db().query('SELECT * FROM items WHERE id = $id').get({ $id: dup.id }) as ItemRow,
      added: qty,
    };
  }

  const info = db()
    .query(
      'INSERT INTO items (week_id, name, quantity, unit, note, status, added_at, product_id) VALUES ($week_id, $name, $quantity, $unit, $note, $status, $added_at, $product_id)',
    )
    .run({
      $week_id: week.id,
      $name: product.name,
      // A new item with no stated count is one of it. "milk" means bring milk,
      // and the sheet should say (1) rather than leave the shopper guessing.
      //
      // INSERT only — deliberately not applied on the merge path above, where a
      // missing --qty has to keep meaning "leave the count alone". Defaulting
      // there would turn every note correction into a silent +1.
      $quantity: qty ?? 1,
      $unit: unit,
      $note: note,
      $status: 'pending',
      $added_at: now(),
      $product_id: product.id,
    });
  return {
    action: 'added',
    item: db().query('SELECT * FROM items WHERE id = $id').get({ $id: Number(info.lastInsertRowid) }) as ItemRow,
    // Mirrors the `qty ?? 1` above: a fresh item with no stated count is one of
    // it, so that is what this call added.
    added: qty ?? 1,
  };
}

/**
 * Create a product for a name nothing claimed, resolving its aisle once.
 *
 * The classifier NEVER throws — no credential, a timeout, a malformed reply, an
 * invented aisle name and an active cooldown all come back as "no answer", and
 * the product is filed under the catch-all so the add still succeeds. A bounded
 * sweep in `lib/bootstrap.ts` gives those another chance later, so an outage
 * costs a temporarily untidy sheet rather than a failed request.
 */
export function newProduct(name: string, pack: LocalePack): { product: ProductRow; categorisedBy: string } {
  const asked = classify(name, listCategories(), pack);
  const categoryId = asked.category ? asked.category.id : catchAllCategoryId();
  return { product: createProduct(name, categoryId), categorisedBy: asked.how };
}

/**
 * An aisle's display name for a product, falling back to the catch-all.
 *
 * The fallback is not decoration: a product whose category row was removed by
 * hand would otherwise print under no heading at all, and a sheet with a
 * headingless block is worse than one that says "Other".
 */
export function aisleNameFor(product: ProductRow): string {
  const direct = product.category_id != null ? getCategory(product.category_id) : null;
  return (direct ?? getCategory(catchAllCategoryId()))?.name ?? '';
}
