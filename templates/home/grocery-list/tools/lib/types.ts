/**
 * Every row shape this CLI reads out of the database, in one file.
 *
 * The tables themselves are created in `lib/bootstrap.ts`, which is the single
 * owner of the DDL — these types are the same shapes written down for the
 * compiler. If you change one, change the other in the same commit.
 *
 * There is deliberately no `items.category_id`: the aisle is a property of the
 * PRODUCT, and storing it twice let the two disagree — an item added before a
 * `recategorise` kept printing under the old heading. `products.category_id` is
 * the only owner, and every read resolves through `items → products →
 * categories`.
 */

/**
 * A shopping week. `week_start` is the DATE of the boundary it opened on, so
 * one date maps to exactly one week and the boundary hour lives only in
 * `lib/time.ts`.
 */
export interface WeekRow {
  id: number;
  week_start: string;
  opened_at: string;
  closed_at: string | null;
  status: string;           // 'open' | 'closed'
}

/**
 * One purchase of one product, in one week.
 *
 * `name` is a COPY of the product's canonical name as it stood when the item
 * was added, not a join. That copy is deliberate: every render path, the `--n`
 * position logic and the in-week merge read `items.name`, and a join would put
 * a later rename in a position to rewrite a sheet that was already printed. A
 * closed week keeps saying what it said at the time.
 */
export interface ItemRow {
  id: number;
  week_id: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  status: string;           // 'pending' | 'bought'
  added_at: string;
  bought_at: string | null;
  /** The product this item is one purchase of. The aisle hangs off this. */
  product_id: number | null;
}

/**
 * An aisle. Seeded from the active locale pack and read-only to the agent —
 * there is no verb that creates one.
 *
 * `key` is the pack's stable identifier (`produce`, `bakery`, …) and never
 * changes; `name` is the display name in the current locale and IS re-written
 * when the locale changes, which is why the two are separate columns. Without
 * the key, switching language would either orphan every product or match
 * categories by a translated string.
 *
 * `sort_order` is print order, and it follows the way a shop actually runs —
 * produce first, household last — so the sheet can be walked top to bottom. The
 * catch-all is pinned last.
 */
export interface CategoryRow {
  id: number;
  key: string;
  name: string;
  sort_order: number;
  /** 1 for the single catch-all aisle. A destination, never a match. */
  is_catch_all: number;
}

/**
 * The thing itself, as opposed to the strings people type at it.
 *
 * `name` is canonical — it is what the chat message and the printed sheet show,
 * whichever phrasing was typed. `name_key` is the folded form and is UNIQUE,
 * which is what makes a phrasing resolve to exactly one product.
 */
export interface ProductRow {
  id: number;
  name: string;
  name_key: string;
  /** The aisle. Never null in practice: an unclassified product gets the catch-all. */
  category_id: number | null;
  created_at: string;
  retired_at: string | null;
}

/** Another phrasing that means the same product. `alias_key` is UNIQUE. */
export interface ProductAliasRow {
  id: number;
  product_id: number;
  alias: string;
  alias_key: string;
  source: string;           // 'user' | 'model'
  added_at: string;
}

/**
 * A deferred `add`, held between the question and the answer.
 *
 * The whole payload is stored here rather than re-passed on the confirming
 * call. Having the agent retype `--name/--qty/--note` is the exact shape that
 * lost "5%" and "250 g" off printed sheets before `printable` became one verb:
 * every re-statement is a chance for a small model to drop a field. The agent
 * carries one opaque token and states intent; nothing else.
 *
 * `created_at` is epoch milliseconds, so the 24-hour TTL is a subtraction
 * rather than a date parse.
 */
export interface PendingAddRow {
  token: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  /** JSON array of candidate product ids, best first. */
  candidates: string;
  created_at: number;
}

/**
 * The payload a `pending_adds` row carries, as the code passes it around.
 *
 * A confirming call IGNORES `--qty` / `--unit` / `--note` outright and uses
 * these — that is the point of the token.
 */
export interface AddPayload {
  name: string;
  qty: number | null;
  unit: string | null;
  note: string | null;
  /** Candidate product ids offered with the question, best first. */
  candidates?: number[];
}
