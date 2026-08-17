/**
 * `categories` and `recategorise` — the aisle surface.
 *
 * READ-ONLY BY DESIGN
 * -------------------
 * There is no verb that adds, removes or reorders an aisle. The eleven come from
 * the active locale pack and change only when the pack does. That is not an
 * oversight: `sort_order` is a judgement about how a physical shop is walked —
 * produce first, household last — so the printed sheet can be shopped top to
 * bottom, and a list whose headings drift with each request is a list nobody can
 * walk. Changing the language renames them in place (`config --locale`); nothing
 * else touches them.
 *
 * `recategorise` TAKES PRODUCT IDS, NOT ITEM POSITIONS
 * ---------------------------------------------------
 * The aisle belongs to the product now, so a fix applies to every purchase of it
 * — past sheets included — rather than to one line on one week's list. The ids
 * come from `products list`. This is the one verb in the tool whose `--id` is a
 * product id; everywhere else a number the group sees is a position (`--n`).
 */
import { catchAllCategoryId, findCategoryByKey, foldForCompare, listCategories } from '../lib/categories.ts';
import type { CommandSpec } from '../lib/cli.ts';
import { emit, flag, flagBool, parseIds, textArg } from '../lib/cli.ts';
import { classify, probe } from '../lib/classify.ts';
import { db } from '../lib/db.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import { loadPack } from '../lib/locale.ts';
import { getProduct, setProductCategory, uncategorisedProductsAfter } from '../lib/products.ts';
import type { CategoryRow, ProductRow } from '../lib/types.ts';

/**
 * The name probed with when none is given — a compound that no aisle name
 * resembles, so a matched answer really did come from the model.
 *
 * English whatever the group's language is, which is fine: the prompt tells the
 * model to answer from the aisle list it is given, so the ANSWER comes back in
 * the pack's language either way. Pass `--name` to probe with a name the group
 * would actually type.
 */
const PROBE_DEFAULT = 'green pesto sauce';

/** How many live products there are — the natural bound for `recategorise --all`. */
function productCount(): number {
  return (db().query('SELECT COUNT(*) AS n FROM products WHERE retired_at IS NULL').get() as { n: number }).n;
}

function countsByCategory(sql: string): Map<number, number> {
  const rows = db().query(sql).all() as { category_id: number | null; n: number }[];
  const counts = new Map<number, number>();
  for (const row of rows) if (row.category_id != null) counts.set(row.category_id, row.n);
  return counts;
}

export const categoriesCommand: CommandSpec = {
  name: 'categories',
  summary: 'list the aisles in print order, or probe whether the classifier is reachable',
  usage: 'grocery.ts categories [--probe] [--name <product name>] [--json]',
  async run(ctx) {
    const cats = listCategories();

    if (flagBool(ctx.args, 'probe')) {
      const pack = loadPack();
      // `--probe "some product"` reads as a value rather than a switch, so the
      // name is taken from there too — otherwise it would be swallowed and the
      // probe would silently test something the operator did not type. Both
      // spellings go through `textArg`, which refuses a name half-eaten by the
      // shell rather than probing the first word of it.
      const name =
        textArg(ctx.args, {
          verb: 'categories --probe',
          usage: categoriesCommand.usage,
          flags: ['name', 'probe'],
        }) || PROBE_DEFAULT;
      const lines = probe(name, cats, pack);

      emit(ctx, { probed: name, aisles: cats.length, results: lines }, (data) => {
        console.log(`probing the classifier with: ${data.probed}`);
        console.log(`aisles offered: ${data.aisles}`);
        for (const line of data.results) console.log(line);
        console.log('');
        console.log('a shape reporting HTTP 200 with a matched aisle means `add` will use the model;');
        console.log('all-failing is safe — new products simply keep landing in the catch-all aisle.');
        if (process.env.MARKETY_CLASSIFY_DISABLED === '1') {
          console.log('');
          console.log('note: MARKETY_CLASSIFY_DISABLED=1 is set, so `add` will NOT call the model');
          console.log('even if a shape above succeeded. This probe ignores the switch on purpose.');
        }
      });
      return;
    }

    const products = countsByCategory('SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id');
    const items = countsByCategory(
      'SELECT p.category_id AS category_id, COUNT(*) AS n FROM items i' +
        ' JOIN products p ON p.id = i.product_id GROUP BY p.category_id',
    );

    const rows = cats.map((category) => ({
      id: category.id,
      key: category.key,
      name: category.name,
      sort_order: category.sort_order,
      catch_all: category.is_catch_all === 1,
      products: products.get(category.id) ?? 0,
      items: items.get(category.id) ?? 0,
    }));

    emit(ctx, rows, (data) => {
      for (const row of data) {
        console.log(
          `#${row.id}\t${String(row.sort_order).padStart(4)}\t${row.key}\t${row.name}` +
            `\t${row.products} product(s)\t${row.items} item(s)${row.catch_all ? '\t(catch-all)' : ''}`,
        );
      }
    });
  },
};

/** `--category` accepts the pack key first, then the display name in any locale. */
function resolveCategory(raw: string, cats: CategoryRow[]): CategoryRow {
  const byKey = findCategoryByKey(raw);
  if (byKey) return byKey;

  const wanted = foldForCompare(raw);
  const byName = cats.find((category) => foldForCompare(category.name) === wanted);
  if (byName) return byName;

  throw new GroceryError(`No aisle "${raw}".`, {
    code: 'usage',
    exitCode: ExitCode.USAGE,
    hint: `Keys: ${cats.map((category) => category.key).join(', ')}. Run \`categories\` to see them.`,
  });
}

interface Change {
  id: number;
  name: string;
  from: string | null;
  to: string;
  how: string;
}

export const recategoriseCommand: CommandSpec = {
  name: 'recategorise',
  summary: 'move a product to another aisle, or re-ask the model about the unclassified ones',
  usage:
    'grocery.ts recategorise (--id <product-id[,id…]> [--category <key>] | --all [--limit <n>]) [--json]',
  async run(ctx) {
    const ids = parseIds(flag(ctx.args, 'id'));
    const all = flagBool(ctx.args, 'all');
    if (ids.length === 0 && !all) {
      throw new GroceryError('recategorise needs --id <product-id> or --all.', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'Product ids come from `products list`. They are NOT list positions.',
      });
    }

    const cats = listCategories();
    const byId = new Map(cats.map((category) => [category.id, category]));
    const catchAll = catchAllCategoryId();

    // An explicit aisle skips the model entirely — that is the whole point of
    // the manual override, and it must work with the classifier unreachable.
    const wanted = flag(ctx.args, 'category');
    const target = wanted !== undefined ? resolveCategory(wanted, cats) : null;

    let targets: ProductRow[];
    if (ids.length > 0) {
      targets = ids.map((id) => getProduct(id)).filter((product): product is ProductRow => product != null);
      const missing = ids.filter((id) => !targets.some((product) => product.id === id));
      if (missing.length > 0) {
        throw new GroceryError(`No product ${missing.join(', ')}.`, {
          code: 'not_found',
          exitCode: ExitCode.NOT_FOUND,
          hint: 'Run `products list` for the ids — these are product ids, not list positions.',
        });
      }
    } else {
      // `--all` is the one path in this CLI that can make many model calls in a
      // row, which is why it is opt-in and never part of an ordinary run. Only
      // products sitting in the catch-all are re-asked: one already filed
      // somewhere was put there by an answer that is no longer visible here, and
      // re-deciding it would quietly undo a correct classification.
      const limitRaw = flag(ctx.args, 'limit');
      const limit = limitRaw !== undefined ? Number(limitRaw) : productCount();
      if (!Number.isFinite(limit)) {
        throw new GroceryError('--limit takes a number.', { code: 'usage', exitCode: ExitCode.USAGE });
      }
      targets = uncategorisedProductsAfter(0, Math.max(0, Math.trunc(limit)));
    }

    const pack = target ? null : loadPack();
    const changes: Change[] = [];
    const skipped: { id: number; name: string; how: string; detail?: string }[] = [];

    for (const product of targets) {
      const from = product.category_id != null ? (byId.get(product.category_id)?.name ?? null) : null;

      let next: CategoryRow | null = target;
      let how = 'explicit';
      let detail: string | undefined;
      if (!next) {
        const asked = classify(product.name, cats, pack!);
        how = asked.how;
        detail = asked.detail;
        next = asked.category;
      }

      // Nothing decided: leave the product exactly where it is. Demoting it to
      // the catch-all on a failed lookup would turn a classifier outage into
      // lost work, which is the opposite of what this verb is for.
      //
      // Recorded rather than swallowed: "examined 3, changed 0" reads like the
      // aisles were already right, when it may mean the classifier is
      // unreachable. `how` distinguishes the two, and `auth` and `transport`
      // need different fixes.
      if (!next || next.id === product.category_id) {
        if (!next) skipped.push({ id: product.id, name: product.name, how, ...(detail === undefined ? {} : { detail }) });
        continue;
      }

      setProductCategory(product.id, next.id);
      changes.push({ id: product.id, name: product.name, from, to: next.name, how });
    }

    emit(
      ctx,
      { examined: targets.length, changed: changes.length, catch_all_id: catchAll, changes, skipped },
      (data) => {
        console.log(`examined ${data.examined}, changed ${data.changed}`);
        for (const change of data.changes) {
          console.log(`#${change.id} ${change.name}: ${change.from ?? '(none)'} → ${change.to} [${change.how}]`);
        }
        for (const miss of data.skipped) {
          console.log(`#${miss.id} ${miss.name}: unchanged — no answer [${miss.how}]${miss.detail ? ` ${miss.detail}` : ''}`);
        }
      },
    );
  },
};
