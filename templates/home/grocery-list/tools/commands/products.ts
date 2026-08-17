/**
 * `products` — the operator surface over product identity.
 *
 * The agent needs none of it. `add` resolves identity on its own and asks the
 * group when it cannot, so nothing here is on the path of an ordinary request.
 * This is where the answers that needed a HUMAN get made: two rows that turned
 * out to be one thing, a canonical name the group stopped using, a phrasing
 * worth teaching by hand.
 *
 * Everything here prints a WORKING VIEW — ids, tabs, English labels — because a
 * verb whose output merely looks sendable is a verb that will eventually be
 * sent. Chat-facing strings come from `add --json`, `message` and `printable`.
 */
import type { CommandSpec } from '../lib/cli.ts';
import { emit, flag, flagBool, noStrayPositionals } from '../lib/cli.ts';
import { listCategories } from '../lib/categories.ts';
import { db } from '../lib/db.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import {
  addAliasFrom,
  aliasesOf,
  findExact,
  getProduct,
  listProducts,
  mergeProducts,
  removeAlias,
  renameProduct,
} from '../lib/products.ts';
import { qtyText } from '../lib/render.ts';
import type { ItemRow, ProductRow } from '../lib/types.ts';
import { openWeekId } from '../lib/weeks.ts';

const SUBCOMMANDS = 'list | get | rename | merge | alias';

function usageError(message: string, hint?: string): never {
  throw new GroceryError(message, {
    code: 'usage',
    exitCode: ExitCode.USAGE,
    ...(hint === undefined ? {} : { hint }),
  });
}

function requireId(raw: string | undefined, what: string): number {
  const value = Number((raw ?? '').replace(/^#/, '').trim());
  if (!Number.isInteger(value) || value <= 0) usageError(`${what} takes a product id.`);
  return value;
}

function itemCount(productId: number): number {
  return (
    db().query('SELECT COUNT(*) AS n FROM items WHERE product_id = $id').get({ $id: productId }) as {
      n: number;
    }
  ).n;
}

/** The aisle name for a product, for display only. */
function aisleNames(): Map<number, string> {
  return new Map(listCategories().map((category) => [category.id, category.name]));
}

interface ProductView {
  id: number;
  name: string;
  category: string | null;
  aliases: string[];
  items: number;
  retired_at: string | null;
}

function view(product: ProductRow, aisles: Map<number, string>): ProductView {
  return {
    id: product.id,
    name: product.name,
    category: product.category_id != null ? (aisles.get(product.category_id) ?? null) : null,
    aliases: aliasesOf(product.id).map((alias) => alias.alias),
    items: itemCount(product.id),
    retired_at: product.retired_at,
  };
}

/** Every product with its aliases and purchase count. `--all` includes retired ones. */
function runList(ctx: Parameters<CommandSpec['run']>[0]): void {
  const includeRetired = flagBool(ctx.args, 'all');
  const search = flag(ctx.args, 'search');
  const limitRaw = flag(ctx.args, 'limit');
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) usageError('--limit takes a number.');

  const aisles = aisleNames();
  const rows = listProducts({
    includeRetired,
    ...(search === undefined ? {} : { search }),
    ...(limit === undefined ? {} : { limit }),
  }).map((product) => view(product, aisles));

  emit(ctx, { count: rows.length, products: rows }, (data) => {
    for (const product of data.products) {
      const aliases = product.aliases.length > 0 ? `  {${product.aliases.join(' | ')}}` : '';
      console.log(
        `#${product.id}\t${product.name}\t[${product.category ?? '-'}]\t${product.items} items` +
          `${aliases}${product.retired_at ? '  (retired)' : ''}`,
      );
    }
    console.log(`\n${data.count} product(s)${includeRetired ? ' including retired' : ''}`);
  });
}

/** One product: its aliases and every purchase of it. */
function runGet(ctx: Parameters<CommandSpec['run']>[0]): void {
  const id = requireId(flag(ctx.args, 'id'), 'products get');
  const product = getProduct(id);
  if (!product) {
    throw new GroceryError(`No product ${id}.`, {
      code: 'not_found',
      exitCode: ExitCode.NOT_FOUND,
      hint: 'Run `products list` to see the ids.',
    });
  }
  const items = db()
    .query('SELECT * FROM items WHERE product_id = $id ORDER BY id DESC')
    .all({ $id: product.id }) as ItemRow[];

  emit(ctx, { ...view(product, aisleNames()), purchases: items }, (data) => {
    console.log(`#${data.id} ${data.name}  [${data.category ?? '-'}]`);
    console.log(`aliases: ${data.aliases.join(' | ') || '(none)'}`);
    for (const item of data.purchases) {
      const qty = qtyText(item.quantity, item.unit);
      console.log(
        `  w${item.week_id} ${item.status}\t${item.name}${qty ? ` (${qty})` : ''}` +
          `${item.note ? ` -- ${item.note}` : ''}`,
      );
    }
  });
}

/**
 * Change the canonical name.
 *
 * The old name becomes an alias so anyone still typing it resolves without being
 * asked. Item names already stored are rewritten only with
 * `--apply-to-current-week`, and only in the open week: a closed week keeps
 * saying what it was shopped under, because a printed sheet is a record and not
 * a view.
 */
function runRename(ctx: Parameters<CommandSpec['run']>[0]): void {
  const id = requireId(flag(ctx.args, 'id'), 'products rename');
  const name = (flag(ctx.args, 'name') ?? '').trim();
  if (!name) usageError('products rename: --name is required.');

  const applyToWeek = flagBool(ctx.args, 'apply-to-current-week');
  const done = renameProduct(id, name, applyToWeek ? openWeekId() : null);
  if (!done) {
    throw new GroceryError(`No product ${id}, or "${name}" already belongs to another product.`, {
      code: 'rename_refused',
      exitCode: ExitCode.NOT_FOUND,
      hint: 'One phrasing belongs to one product; use `products merge` to fold two together.',
    });
  }
  emit(ctx, done, (data) => {
    console.log(
      `renamed #${data.product.id} → ${data.product.name} ` +
        `(${data.renamed_items} item(s) on the current list rewritten)`,
    );
  });
}

/** Fold one product into another — the verb for "these two are the same thing". */
function runMerge(ctx: Parameters<CommandSpec['run']>[0]): void {
  const from = requireId(flag(ctx.args, 'from'), 'products merge --from');
  const into = requireId(flag(ctx.args, 'into'), 'products merge --into');

  const done = mergeProducts(from, into, openWeekId());
  if (!done) {
    throw new GroceryError(`Cannot merge ${from} into ${into}.`, {
      code: 'merge_refused',
      exitCode: ExitCode.NOT_FOUND,
      hint: 'Both ids must exist, they must differ, and the winner must not be retired.',
    });
  }
  emit(ctx, done, (data) => {
    console.log(
      `merged "${data.from.name}" into "${data.into.name}": ${data.items} item(s) repointed, ` +
        `${data.aliases} alias(es) moved, ${data.collapsed} duplicate line(s) collapsed on the current list`,
    );
  });
}

/**
 * Teach or unteach a phrasing by hand.
 *
 * One phrasing belongs to exactly ONE product, so this refuses rather than
 * steals — a phrasing that already resolves somewhere has to be removed from
 * there first. Silently repointing it would change what an old sheet meant.
 */
function runAlias(ctx: Parameters<CommandSpec['run']>[0]): void {
  const action = ctx.args.positionals[1];

  if (action === 'add') {
    const id = requireId(flag(ctx.args, 'id'), 'products alias add');
    const text = (flag(ctx.args, 'alias') ?? '').trim();
    if (!text) usageError('products alias add: --alias is required.');

    const product = getProduct(id);
    if (!product) {
      throw new GroceryError(`No product ${id}.`, { code: 'not_found', exitCode: ExitCode.NOT_FOUND });
    }
    // Retired products included: a retired row still owns its phrasing until a
    // merge releases the key, so "free" has to mean free of everything.
    const owner = findExact(text, true)?.product ?? null;
    const added = owner ? false : addAliasFrom(product.id, text, 'operator');
    emit(ctx, { added, alias: text, product: { id: product.id, name: product.name }, owner }, (data) => {
      console.log(
        data.added
          ? `"${data.alias}" now means ${data.product.name}`
          : `"${data.alias}" already belongs to #${data.owner?.id} ${data.owner?.name} — remove it there first`,
      );
    });
    return;
  }

  if (action === 'remove') {
    const text = (flag(ctx.args, 'alias') ?? '').trim();
    if (!text) usageError('products alias remove: --alias is required.');
    const removed = removeAlias(text);
    emit(ctx, { removed, alias: text }, (data) => {
      console.log(data.removed ? `removed alias "${data.alias}"` : `no such alias "${data.alias}"`);
    });
    return;
  }

  usageError(`products alias: unknown action "${action ?? ''}" (add | remove).`);
}

export const productsCommand: CommandSpec = {
  name: 'products',
  summary: 'the operator surface over product identity: list, get, rename, merge, alias',
  // `alias` is the one subcommand that takes an action of its own, so it gets its
  // own line: a single-line form implies `products alias --alias <text>`, which
  // the verb rejects.
  usage:
    'grocery.ts products <list|get|rename|merge> ' +
    '[--id <product-id>] [--all] [--search <text>] [--limit <n>] ' +
    '[--name <text>] [--apply-to-current-week] [--from <id> --into <id>] [--json]\n' +
    '  grocery.ts products alias <add|remove> [--id <product-id>] --alias <text> [--json]',
  async run(ctx) {
    const sub = ctx.args.positionals[0] ?? 'list';
    // This verb's positionals are SUBCOMMANDS, so the unquoted-name accident
    // lands past them rather than in a text argument: `products rename --id 5
    // --name קוקה קולה` leaves `קולה` behind, and the rename would take the
    // first word and report success. `alias` owns a second positional (its
    // action); every other subcommand owns one.
    noStrayPositionals(ctx.args, {
      verb: `products ${sub}`,
      usage: productsCommand.usage,
      consumed: sub === 'alias' ? 2 : 1,
    });
    switch (sub) {
      case 'list':
        return runList(ctx);
      case 'get':
        return runGet(ctx);
      case 'rename':
        return runRename(ctx);
      case 'merge':
        return runMerge(ctx);
      case 'alias':
        return runAlias(ctx);
      default:
        usageError(`products: unknown subcommand "${sub}" (${SUBCOMMANDS}).`);
    }
  },
};
