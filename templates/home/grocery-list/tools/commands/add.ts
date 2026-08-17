/**
 * `add` — put something on this week's list.
 *
 * Everything the group buys is a PRODUCT, and the words typed at it are
 * aliases. `add` therefore resolves an identity before it writes anything.
 *
 * When that resolution is uncertain the command writes NOTHING: it parks the
 * whole add — name, quantity, unit, note — under a token and returns a
 * question. The obvious alternative, where the confirming call re-passes the
 * fields, is exactly the shape that lost "5%" and "250 g" off printed sheets.
 * The agent carries one opaque token and states intent; it cannot drop a field
 * it never holds.
 *
 * The token is never shown to the group. It is a handle between two of the
 * agent's own calls, and pasting it into a chat is how a question stops looking
 * like a question.
 */
import { emit, flag, flagBool, textArg, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { loadPack } from '../lib/locale.ts';
import { consumePendingAdd, createPendingAdd } from '../lib/product-match.ts';
import { addAliasFrom, getProduct } from '../lib/products.ts';
import {
  addPurchase,
  aisleNameFor,
  identify,
  newProduct,
  type AddResult,
} from '../lib/purchases.ts';
import { renderConfirm, renderWorkingAdd } from '../lib/render.ts';
import type { ProductRow } from '../lib/types.ts';
import { currentWeek } from '../lib/weeks.ts';

interface AddedPayload {
  action: 'added' | 'merged';
  added: number | null;
  item: AddResult['item'];
  product: { id: number; name: string; status: 'new' | 'known' };
  category: string;
  categorised_by: string;
  confirm: ReturnType<typeof renderConfirm>;
}

interface QuestionPayload {
  action: 'needs_confirmation';
  token: string;
  typed: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  judged_by: string;
  candidates: { id: number; name: string; matched: string; via: 'name' | 'alias'; how: string }[];
}

/**
 * The shape both writing paths print. Keeps the two exits from drifting apart.
 *
 * `--json` carries `confirm`, the rendered reply. That is the whole point of
 * this verb's output: the caller forwards a string it did not compose, exactly
 * as it does for `message`.
 */
function reportAdd(
  ctx: CommandContext,
  result: AddResult,
  product: ProductRow,
  categorisedBy: string,
): void {
  const pack = loadPack();
  const aisle = aisleNameFor(product);
  const payload: AddedPayload = {
    action: result.action,
    added: result.added,
    item: result.item,
    product: { id: product.id, name: product.name, status: result.isNewProduct ? 'new' : 'known' },
    category: aisle,
    categorised_by: categorisedBy,
    confirm: renderConfirm(result, pack),
  };
  emit(ctx, payload, () => console.log(renderWorkingAdd(result, aisle, categorisedBy)));
}

/** Answering a question `add` asked earlier. */
function confirmPendingAdd(ctx: CommandContext): void {
  const pack = loadPack();
  const sameAsRaw = flag(ctx.args, 'same-as');
  const asNew = flagBool(ctx.args, 'new-product', false);
  const token = flag(ctx.args, 'confirm')!;

  // Validated BEFORE the token is consumed: a bad flag must not eat the pending
  // add and leave the user's item nowhere.
  if ((sameAsRaw === undefined) === !asNew) {
    throw new GroceryError('Pass exactly one of --same-as <product-id> or --new-product.', {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: '--same-as teaches this phrasing permanently; --new-product files it as its own product.',
    });
  }
  const sameAs = sameAsRaw === undefined ? null : Number(sameAsRaw);
  if (sameAs != null && !Number.isFinite(sameAs)) {
    throw new GroceryError('--same-as takes a product id.', {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: 'The ids are in `grocery.ts products list`.',
    });
  }
  const target = sameAs != null ? getProduct(sameAs) : null;
  if (sameAs != null && (!target || target.retired_at)) {
    throw new GroceryError(`No product ${sameAs}.`, {
      code: 'not_found',
      exitCode: ExitCode.NOT_FOUND,
      hint: 'The ids are in `grocery.ts products list`.',
    });
  }

  // Throws NOT_FOUND on an unknown or expired token, deliberately loudly: that
  // is the command saying "run `add` again", not "guess what was meant".
  const held = consumePendingAdd(token);

  // The week is resolved NOW, not when the question was asked. An answer that
  // arrives after the boundary belongs to the week the user is looking at, not
  // to the one that has since closed.
  const week = currentWeek();
  let product: ProductRow;
  let isNewProduct: boolean;
  let categorisedBy: string;

  if (target) {
    // The typed phrasing becomes an alias, so this is asked exactly once, ever.
    // That convergence is the whole point of the question.
    addAliasFrom(target.id, held.payload.name, 'user');
    product = target;
    isNewProduct = false;
    categorisedBy = 'product';
  } else {
    const made = newProduct(held.payload.name, pack);
    product = made.product;
    isNewProduct = true;
    categorisedBy = made.categorisedBy;
  }

  const result = addPurchase(week, product, held.payload.qty, held.payload.unit, held.payload.note);
  reportAdd(ctx, { ...result, isNewProduct }, product, categorisedBy);
}

function ordinaryAdd(ctx: CommandContext): void {
  const pack = loadPack();
  const week = currentWeek();
  const name = textArg(ctx.args, {
    verb: 'add',
    usage: addCommand.usage,
    flags: ['name'],
  });
  if (!name) {
    throw new GroceryError('add: a name is required.', {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: 'grocery.ts add --name "milk" [--qty 2] [--unit l] [--note "3%"]',
    });
  }

  const qtyRaw = flag(ctx.args, 'qty');
  const qty = qtyRaw === undefined ? null : Number(qtyRaw);
  if (qty != null && !Number.isFinite(qty)) {
    throw new GroceryError('--qty must be a number.', { code: 'usage', exitCode: ExitCode.USAGE });
  }
  const unit = flag(ctx.args, 'unit') ?? null;
  const note = flag(ctx.args, 'note') ?? null;

  const identity = identify(name, pack);

  if (identity.kind === 'candidates') {
    // NOTHING is written on this path — not the item, not a product. The whole
    // add waits in the token until someone answers.
    const pending = createPendingAdd({
      name,
      qty,
      unit,
      note,
      candidates: identity.candidates.map((c) => c.product.id),
    });
    const payload: QuestionPayload = {
      action: 'needs_confirmation',
      token: pending.token,
      typed: name,
      quantity: qty,
      unit,
      note,
      judged_by: identity.judged,
      candidates: identity.candidates.map((c) => ({
        id: c.product.id,
        name: c.product.name,
        // `matched` is the stored string that actually fired — the canonical
        // name, or the alias that means it. Shown because "also written X" is
        // often the whole answer to "is this the same thing?".
        matched: c.matched,
        via: c.via,
        how: c.how,
      })),
    };
    emit(ctx, payload, (data) => {
      console.log(`needs confirmation: "${data.typed}" (judged_by: ${data.judged_by})`);
      for (const candidate of data.candidates) {
        const also = candidate.via === 'alias' ? ` — also written "${candidate.matched}"` : '';
        console.log(`  #${candidate.id} ${candidate.name}${also} [${candidate.how}]`);
      }
      console.log(`  same product:  add --confirm ${data.token} --same-as ${data.candidates[0]?.id ?? '<id>'}`);
      console.log(`  different one: add --confirm ${data.token} --new-product`);
    });
    return;
  }

  if (identity.kind === 'exact') {
    const result = addPurchase(week, identity.product, qty, unit, note);
    reportAdd(ctx, { ...result, isNewProduct: false }, identity.product, 'product');
    return;
  }

  const made = newProduct(name, pack);
  const result = addPurchase(week, made.product, qty, unit, note);
  reportAdd(ctx, { ...result, isNewProduct: true }, made.product, made.categorisedBy);
}

export const addCommand: CommandSpec = {
  name: 'add',
  summary: "Put something on this week's list, or answer a question a previous add asked.",
  usage:
    'grocery.ts add --name <text> [--qty <n>] [--unit <text>] [--note <text>] [--json]\n' +
    '  grocery.ts add --confirm <token> (--same-as <product-id> | --new-product) [--json]',
  async run(ctx: CommandContext) {
    if (flag(ctx.args, 'confirm')) {
      confirmPendingAdd(ctx);
      return;
    }
    ordinaryAdd(ctx);
  },
};
