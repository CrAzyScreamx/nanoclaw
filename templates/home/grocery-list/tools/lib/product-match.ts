/**
 * lib/product-match.ts — "which product might this be", and the token that holds
 * an `add` between the question and the answer.
 *
 * MATCHING IS A LADDER, AND ONLY THE FIRST RUNG IS CHEAP
 * -----------------------------------------------------
 * `findExact` (lib/products.ts) is a key lookup and covers the overwhelming
 * majority of adds — free, instant, no question. Anything it misses reaches
 * `searchCandidates` here, which proposes with three deliberately narrow string
 * rules, and only what those propose reaches the model (`judgeProduct`).
 *
 * The rules are tuned for PRECISION, not recall. A candidate costs a model call
 * and possibly a question to the group, so a shares-one-word rule is not a cheap
 * over-approximation — measured over the source group's real name list it fired
 * on 48 of 63 pairs, which would make every "red pepper" ask about "yellow
 * pepper". The near-spelling rung exists because two spellings of one product
 * can differ by a single letter and share no substring and no token; a token
 * rule cannot see them and a word rule drags in the whole pepper aisle.
 *
 * Nothing here decides a merge on its own. A surviving candidate becomes a
 * QUESTION; the answer is written back as an alias, and that phrasing is never
 * asked about again.
 *
 * THE TOKEN
 * ---------
 * When identity is uncertain, `add` writes NOTHING and returns a token plus up
 * to four candidates. The token carries the whole add — name, quantity, unit,
 * note — and the confirming call IGNORES those flags outright, because every
 * re-statement is a chance for a small model to drop a qualifier like "5%" or
 * "250 g". The agent carries one opaque token and states intent; it cannot drop
 * a field it never holds, and a token is never shown to the group.
 *
 * The TTL is a full day on purpose — the group's answer arrives in a later turn,
 * sometimes the next morning. An unknown or expired token FAILS LOUDLY: that is
 * the command saying "run `add` again", not "guess".
 */
import { foldForCompare } from './categories.ts';
import { db } from './db.ts';
import { ExitCode, GroceryError } from './errors.ts';
import { listAliases, listProducts } from './products.ts';
import type { AddPayload, PendingAddRow, ProductRow } from './types.ts';

/** How long an unanswered question stays answerable. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on proposed candidates — a question with six options is not a question. */
export const MAX_CANDIDATES = 4;

/** A product the typed name might mean. Never applied without confirmation. */
export interface Candidate {
  product: ProductRow;
  /** The stored string that matched — the canonical name or one of its aliases. */
  matched: string;
  via: 'name' | 'alias';
  how: 'substring' | 'subset' | 'spelling';
  /** 0..1, higher is closer. Ordering only; it is not a probability. */
  score: number;
}

export interface PendingAdd {
  token: string;
  payload: AddPayload;
  /** Epoch milliseconds, so the TTL is a subtraction rather than a date parse. */
  created_at: number;
}

/* ------------------------------------------------------------------ matching */

/** Words worth comparing. Two-letter words match almost everything. */
function tokens(key: string): string[] {
  return key.split(' ').filter((word) => word.length >= 3);
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `cap`. Bounded because
 * it only ever runs on pairs of near-equal length, and the answer past the cap
 * is never needed.
 */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (row[j]! < best) best = row[j]!;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Does `typedKey` plausibly name the same thing as `storedKey`? Returns the rule
 * that fired and a score for ordering, or null.
 *
 * Both arguments are already folded (`foldForCompare`). Identical keys return null —
 * that is an exact hit, which `findExact` owns, not a candidate.
 */
export function matchRule(
  typedKey: string,
  storedKey: string,
): { how: Candidate['how']; score: number } | null {
  if (!typedKey || !storedKey || typedKey === storedKey) return null;

  const short = typedKey.length <= storedKey.length ? typedKey : storedKey;
  const long = short === typedKey ? storedKey : typedKey;

  // One name contains the other outright: "zero" inside "cola zero crate".
  // Guarded on length because a two-character needle is inside everything.
  if (short.length >= 3 && long.includes(short)) {
    return { how: 'substring', score: short.length / long.length };
  }

  // Every meaningful word of the shorter name appears in the longer one:
  // "ski cheese" ⊂ "ski white cheese". Not contiguous, so substring misses it.
  const shortTokens = tokens(short);
  const longTokens = tokens(long);
  if (
    shortTokens.length > 0 &&
    shortTokens.length < longTokens.length &&
    shortTokens.every((token) => longTokens.includes(token))
  ) {
    return { how: 'subset', score: shortTokens.length / longTokens.length };
  }

  // A spelling variant of the same words: one letter apart, with no shared
  // substring and no shared token to find it by.
  //
  // ONE edit, not two. Two is where this rule stops describing spelling and
  // starts describing the qualifier that distinguishes two real products: in the
  // source group's name list "red pepper"/"orange pepper", "dish soap"/"Kif
  // soap" and "mayonnaise"/"melon" were all exactly two edits apart and all
  // three are different things. Measured over that list, a cap of 1 dropped
  // every false pair and kept the only true one. The length floor keeps short
  // words out, where a single letter is already a different product.
  if (long.length >= 5) {
    const distance = editDistance(typedKey, storedKey, 1);
    if (distance <= 1) return { how: 'spelling', score: 1 - distance / long.length };
  }

  return null;
}

/**
 * Products a typed name might mean, best first, with the string that matched.
 *
 * Searches canonical names AND aliases, so a phrasing learned last month can be
 * what surfaces the product today. Retired products are never proposed.
 * Deterministic and free — no model. The model's job is to JUDGE this list, not
 * to build it.
 *
 * `searchCandidates` below is the contracted form and returns just the products;
 * this one keeps `matched` / `via` / `how`, which is what lets the question name
 * the phrasing that caused it ("also written …") instead of only the product.
 */
export function searchCandidateMatches(raw: string, limit = MAX_CANDIDATES): Candidate[] {
  const key = foldForCompare(raw);
  if (!key) return [];

  const products = listProducts();
  const byId = new Map(products.map((product) => [product.id, product]));
  const best = new Map<number, Candidate>();

  const consider = (
    product: ProductRow,
    matched: string,
    storedKey: string,
    via: 'name' | 'alias',
  ): void => {
    const rule = matchRule(key, storedKey);
    if (!rule) return;
    const prior = best.get(product.id);
    if (prior && prior.score >= rule.score) return;
    best.set(product.id, { product, matched, via, how: rule.how, score: rule.score });
  };

  for (const product of products) consider(product, product.name, product.name_key, 'name');
  for (const alias of listAliases()) {
    const product = byId.get(alias.product_id);
    if (product) consider(product, alias.alias, alias.alias_key, 'alias');
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.product.id - b.product.id)
    .slice(0, limit);
}

/** The contracted form: the same search, products only, best first. */
export function searchCandidates(raw: string, limit = MAX_CANDIDATES): ProductRow[] {
  return searchCandidateMatches(raw, limit).map((candidate) => candidate.product);
}

/* ------------------------------------------------------------ deferred adds */

function toPending(row: PendingAddRow): PendingAdd {
  let candidates: number[] = [];
  try {
    const parsed = JSON.parse(row.candidates) as unknown;
    if (Array.isArray(parsed)) candidates = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    /* a malformed candidate list costs the offer, never the add */
  }
  return {
    token: row.token,
    created_at: row.created_at,
    payload: {
      name: row.name,
      qty: row.quantity,
      unit: row.unit,
      note: row.note,
      candidates,
    },
  };
}

/**
 * Park an add under a token.
 *
 * The week is deliberately NOT recorded: the confirming call resolves it again,
 * so an answer that arrives after the week rolled over belongs to the week the
 * group is looking at rather than the one that has since closed.
 */
export function createPendingAdd(payload: AddPayload): PendingAdd {
  const token = crypto.randomUUID().slice(0, 8);
  const createdAt = Date.now();
  db()
    .query(
      'INSERT INTO pending_adds (token, name, quantity, unit, note, candidates, created_at)' +
        ' VALUES ($token, $name, $quantity, $unit, $note, $candidates, $created_at)',
    )
    .run({
      $token: token,
      $name: payload.name,
      $quantity: payload.qty,
      $unit: payload.unit,
      $note: payload.note,
      $candidates: JSON.stringify(payload.candidates ?? []),
      $created_at: createdAt,
    });
  return { token, created_at: createdAt, payload };
}

/**
 * Read and spend a token.
 *
 * Single-use, and an unknown, spent or expired token throws NOT_FOUND naming the
 * fix. Failing loudly is the behaviour: a silently-ignored token would leave the
 * group's item nowhere at all, with a confirmation that looked like it worked.
 */
export function consumePendingAdd(token: string): PendingAdd {
  const wanted = token.trim();
  const row = db().query('SELECT * FROM pending_adds WHERE token = $t').get({ $t: wanted }) as
    | PendingAddRow
    | null;

  const refuse = (): never => {
    throw new GroceryError(`Unknown or expired confirmation token "${wanted}".`, {
      code: 'pending_add_not_found',
      exitCode: ExitCode.NOT_FOUND,
      hint: 'Run `add` again to ask afresh — a question stays answerable for one day.',
    });
  };

  if (!row) refuse();
  db().query('DELETE FROM pending_adds WHERE token = $t').run({ $t: wanted });
  if (Date.now() - row!.created_at > PENDING_TTL_MS) refuse();
  return toPending(row!);
}

/**
 * Drop questions nobody answered.
 *
 * Called from `bootstrap()` on every invocation rather than from `add`, so it
 * happens whether or not anyone ever runs `add` again.
 */
export function purgeExpiredPendingAdds(): void {
  db()
    .query('DELETE FROM pending_adds WHERE created_at < $cutoff')
    .run({ $cutoff: Date.now() - PENDING_TTL_MS });
}
