/**
 * Every line this CLI prints for a human, in one place.
 *
 * TWO AUDIENCES THAT MUST NOT CONVERGE
 * ------------------------------------
 * `renderMessage` and `renderConfirm` produce text meant to be forwarded to the
 * group VERBATIM. The `renderWorking*` helpers produce a view meant to be READ
 * by the agent and to look obviously unsendable if it is not.
 *
 * That second half is not decoration. A chat-ready working view is how row ids
 * and status marks reach the group: asked for the list, the agent runs `list`,
 * pastes the result under a heading of its own, and the reply looks right.
 * Instructions alone do not fix that — the shortcut keeps working, so it keeps
 * being taken. So the shortcut fails visibly: `#` id prefixes, no direction
 * marks, an English banner. Pasting it anywhere produces obvious garbage.
 *
 * WHERE THE WORDS COME FROM
 * -------------------------
 * Everything user-visible comes from `pack.strings` (lib/locale.ts); nothing is
 * spelled out in this file. The working view is the one exception, and
 * deliberately so: it is English, unlocalised and ugly on purpose, because it is
 * not for a person in the group.
 *
 * BIDIRECTIONAL TEXT
 * ------------------
 * `RLM` insertion and `sealLatin` run ONLY when `pack.dir === 'rtl'`. In a
 * left-to-right pack they would be invisible junk in every line and would show
 * up in any consumer that counts characters.
 */
import { t, type LocalePack } from './locale.ts';
import type { AddResult } from './purchases.ts';
import type { ItemRow } from './types.ts';

/**
 * Right-to-left mark. In an RTL pack every rendered line starts with one so the
 * paragraph direction is unambiguous even when the line opens with a digit or a
 * symbol — a chat client otherwise infers direction from the first strong
 * character and left-aligns any line that begins with `1.` or `✓`.
 */
export const RLM = '‏';

/**
 * Terminate embedded Latin runs with an RLM.
 *
 * Without this, a Latin word followed by a number coalesces into ONE
 * left-to-right run under the bidi algorithm: `ביצים L — 4` renders the
 * quantity as part of the Latin fragment and strands it at the far left, away
 * from the item it belongs to. Sealing the run restores RTL context before the
 * number, so the quantity stays with its item.
 *
 * Pure, and unconditional on its own — every CALLER gates it on
 * `pack.dir === 'rtl'`. Applied to a left-to-right language it would sprinkle
 * an invisible mark after every word for no reason.
 */
export function sealLatin(text: string): string {
  return text.replace(/[A-Za-z]+(?:[.'’\-][A-Za-z]+)*%?/g, (run) => run + RLM);
}

/**
 * The line-opening direction mark for this pack: one RLM, or nothing at all.
 *
 * Exported because the verbs that print a section heading of their own
 * (`report`, `rotate`) need the same mark on it, and a second copy of the
 * literal in a command file is a copy that gets forgotten when a pack changes.
 */
export function lineMark(pack: LocalePack): string {
  return pack.dir === 'rtl' ? RLM : '';
}

/** Local alias, so the render helpers below stay short. */
const mark = lineMark;

/** `sealLatin` in an RTL pack, the identity function in an LTR one. */
function seal(pack: LocalePack, text: string): string {
  return pack.dir === 'rtl' ? sealLatin(text) : text;
}

/**
 * Count and unit as bare text: `2 l`, `2`, `l`, or empty when there is neither.
 * The printed sheet gives this a column of its own; the chat lines wrap it.
 */
export function qtyText(qty: number | null, unitRaw: string | null): string {
  const unit = unitRaw?.trim() ?? '';
  if (qty != null) return unit ? `${qty} ${unit}` : String(qty);
  return unit;
}

/**
 * The same, parenthesised for a chat line, with the unit sealed in an RTL pack.
 *
 * Parentheses directly after the name rather than behind a dash — a neutral
 * separator between a word and a digit is exactly what the bidi algorithm
 * reorders unpredictably. `pack` is null for the working view, which is
 * unlocalised and never sealed.
 */
function quantity(pack: LocalePack | null, qty: number | null, unitRaw: string | null): string {
  const trimmed = unitRaw?.trim() ?? '';
  const text = qtyText(qty, trimmed && pack ? seal(pack, trimmed) : trimmed);
  return text ? ` (${text})` : '';
}

/**
 * One item as a chat line: `1. Ski cheese (1) — 250 g 5%`.
 *
 * `n === null` for a list that is not a `--n` target — a bought list, or the
 * items just carried into a new week. An unnumbered line cannot be quoted back
 * as a position that means something else.
 */
function chatLine(item: ItemRow, n: number | null, pack: LocalePack, isNewProduct = false): string {
  const name = seal(pack, item.name);
  const qty = quantity(pack, item.quantity, item.unit);
  const note = item.note ? ` — ${seal(pack, item.note)}` : '';
  const tail = isNewProduct ? ` ${t(pack, 'newProductTail')}` : '';
  return `${mark(pack)}${n == null ? '' : `${n}. `}${name}${qty}${note}${tail}`;
}

/**
 * The chat message for a week's pending items, ready to send verbatim.
 *
 * Channel-neutral: no bold syntax, no client-specific markup. A heading that
 * carries `*asterisks*` renders as literal asterisks everywhere except the one
 * client the syntax was written for, and this template does not know which
 * client it is wired to.
 *
 * An empty list is a one-line message and NOT an error — "nothing to buy" is an
 * answer the group wants, unlike an empty sheet, which is not worth printing.
 *
 * WHY THE NEW-PRODUCT MARKER IS REPEATED HERE
 * -------------------------------------------
 * `renderConfirm` already puts `newProductTail` on the confirmation for an `add`
 * that invented a product, and that was the group's only chance to notice one.
 * It is not enough, because reaching it depends on the assistant running
 * `add --json` and forwarding `confirm.line` — and an assistant that instead runs
 * plain `add` and then `message` produces a correct-looking list in which a
 * product that has never existed before is indistinguishable from one the
 * household has bought for years. That happened on 2026-08-16: `אגוזים` became a
 * second product beside `אגוזי לוז` and the list gave no sign of it.
 *
 * So the marker lives on the surface the group actually reads, and it is a
 * property of the DATA rather than of the call that produced it: `newProductIds`
 * holds the items that are the first appearance ever of their product, so the
 * mark is identical whichever verb path led here, and it disappears by itself the
 * next time that product is listed. Callers that cannot cheaply know it pass
 * nothing and get the old rendering.
 */
export function renderMessage(items: ItemRow[], pack: LocalePack, newProductIds?: ReadonlySet<number>): string {
  const m = mark(pack);
  if (items.length === 0) return `${m}${t(pack, 'listEmpty')}`;
  const lines = items.map((item, i) => chatLine(item, i + 1, pack, newProductIds?.has(item.id) ?? false));
  return [`${m}${t(pack, 'listHeading')}`, '', ...lines].join('\n');
}

/** A pending list rendered with its display positions, for a chat reply. */
export function renderNumbered(items: ItemRow[], pack: LocalePack): string {
  if (items.length === 0) return `${mark(pack)}${t(pack, 'emptyShort')}`;
  return items.map((item, i) => chatLine(item, i + 1, pack)).join('\n');
}

/** A list rendered without numbers — see the `n === null` note on `chatLine`. */
export function renderPlain(items: ItemRow[], pack: LocalePack): string {
  if (items.length === 0) return `${mark(pack)}${t(pack, 'emptyShort')}`;
  return items.map((item) => chatLine(item, null, pack)).join('\n');
}

/**
 * Stamp display positions onto a pending list for JSON consumers.
 *
 * `n` first, so it is the field the agent reads before `id`. Both are present
 * because the two callers genuinely differ: `n` is what goes into a message,
 * `id` is what the agent may need to pass to a verb that takes ids — and the
 * two number spaces never line up, which is the whole reason this exists.
 */
export function withPositions(items: ItemRow[]): (ItemRow & { n: number })[] {
  return items.map((item, i) => ({ n: i + 1, ...item }));
}

/**
 * The confirmation for one `add`, ready to send verbatim.
 *
 * The caller sends `line` — or stacks each `item` under one `header` for a
 * multi-item add — and never learns the shape at all. Left to the agent to
 * reproduce, a format carrying two invisible direction marks and a
 * merge-only tail drifts, and nothing catches it.
 *
 * Three verbs, because the three outcomes genuinely read differently:
 *   added    ✓ Added: Milk (2)
 *   merged   ✓ Added: Milk (2) — now 5        (this call raised the count)
 *   updated  ✓ Updated: Ski cheese (1)        (a note fix; count untouched)
 *
 * `updated` exists because a merge with no `--qty` is a real case the old
 * template had no shape for: correcting a dropped "250 g" moves nothing but the
 * note, and reporting that as "added" claims a purchase that never happened.
 */
export interface ConfirmObject {
  verb: 'added' | 'merged' | 'updated';
  header: string;
  item: string;
  line: string;
}

export function renderConfirm(result: AddResult, pack: LocalePack): ConfirmObject {
  const verb: ConfirmObject['verb'] =
    result.action === 'added' ? 'added' : result.added != null ? 'merged' : 'updated';

  // On a merge the parentheses show what THIS call contributed, with the new
  // total in the tail — "(2) — now 5". Everywhere else it is the stored count,
  // which for a fresh add is what was asked for.
  const shown = verb === 'merged' ? result.added : result.item.quantity;
  const qty = quantity(pack, shown, result.item.unit);

  // A merge already ends in the "now N" tail; a product cannot be new on that
  // path anyway, since a pending row for it is what caused the merge.
  const tail =
    verb === 'merged'
      ? ` ${t(pack, 'mergeTail', { total: result.item.quantity ?? 0 })}`
      : result.isNewProduct
        ? ` ${t(pack, 'newProductTail')}`
        : '';

  const body = `${seal(pack, result.item.name)}${qty}${tail}`;
  const label = verb === 'updated' ? t(pack, 'confirmUpdated') : t(pack, 'confirmAdded');
  const check = t(pack, 'confirmMark');
  const m = mark(pack);
  return {
    verb,
    header: `${m}${check} ${label}:`,
    item: `${m}${body}`,
    line: `${m}${check} ${label}: ${body}`,
  };
}

// --------------------------------------------------------------- working view

/**
 * The banner every working view opens with.
 *
 * English and unlocalised on purpose: it is addressed to the agent, not to the
 * group, and its job is to be the first thing that looks wrong if this output
 * is ever pasted into a conversation.
 */
export const WORKING_BANNER =
  '# working view - ids, NOT list numbers. do not send this; run `message` for the group.';

/** One working-view row: `#144  [pending] Milk (2) -- 3%`. */
function workingRow(item: ItemRow): string {
  return `#${item.id}  [${item.status}] ${item.name}${workingTail(item)}`;
}

/** The unlocalised `(2 l) -- 3%` tail the working views share. */
function workingTail(item: ItemRow): string {
  return `${quantity(null, item.quantity, item.unit)}${item.note ? ` -- ${item.note}` : ''}`;
}

/**
 * Working output — what the agent reads in order to think, from `list`, `find`
 * and `unmark`.
 *
 * Deliberately NOT shaped like something sendable: a `#` prefix (a neutral
 * character that reorders unpredictably against right-to-left text), no
 * direction mark at line start (so any line with a digit renders backwards in an
 * RTL group), and an English banner. `--json` is untouched: machine reads stay
 * exact.
 */
export function renderWorking(items: ItemRow[]): string {
  if (items.length === 0) return `${WORKING_BANNER}\n# (empty)`;
  return [WORKING_BANNER, ...items.map(workingRow)].join('\n');
}

/**
 * The working view for items whose status just changed, with the pack's status
 * mark in front of each — the one localised character this view carries,
 * because `✓` and `○` mean the same thing in every language and a shopper
 * reading over the agent's shoulder should see the same symbols the sheet uses.
 */
export function renderMarked(items: ItemRow[], pack: LocalePack, status: 'bought' | 'pending'): string {
  const symbol = t(pack, status === 'bought' ? 'markBought' : 'markPending');
  if (items.length === 0) return `${WORKING_BANNER}\n# (none)`;
  return [WORKING_BANNER, ...items.map((item) => `${symbol} ${workingRow(item)}`)].join('\n');
}

/**
 * The working view for one `add`.
 *
 * Numbered by ROW ID — the one number the group must never see — and shaped so
 * that pasting it fails visibly, the same rule the other working views follow.
 * The sendable version of this is `--json`'s `confirm.line`.
 */
export function renderWorkingAdd(
  result: AddResult,
  aisle: string,
  categorisedBy: string,
): string {
  const suffix = result.isNewProduct ? ' (new product)' : '';
  return [
    '# working view - ids, NOT list numbers. do not send this; run with --json and send confirm.line.',
    `#${result.item.id}  [${result.action}] ${result.item.name}` +
      `${workingTail(result.item)} [${aisle} / ${categorisedBy}]${suffix}`,
  ].join('\n');
}
