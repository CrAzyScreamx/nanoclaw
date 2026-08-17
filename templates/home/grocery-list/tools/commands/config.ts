/**
 * `config` — read or change the three settings this template has.
 *
 * There are exactly three, and each is a decision a HUMAN makes once:
 *
 *   --locale <tag>              which language the list speaks
 *   --week-start <dow>:<hour>   when the shopping week turns over
 *   --remember-corrections      may the receipt reader remember what it misread
 *
 * With no flags it prints the current settings, which is how `SETUP.md` checks
 * its own work and how the welcome skill finds out what language to greet in.
 *
 * WHY CHANGING THE LOCALE IS SAFE
 * -------------------------------
 * Aisles are matched on their pack `key`, never on their display name, so
 * switching language RENAMES the eleven categories in place. Products keep
 * their aisle, closed weeks keep their items, and nothing is re-classified.
 * What does not change is text already written: an item added as "milk" stays
 * "milk" on the sheet, because `items.name` is a copy taken at the time and a
 * closed week keeps saying what it said.
 *
 * This verb writes `config.json`. The database is untouched except for the
 * category display names.
 */
import { seedCategories } from '../lib/categories.ts';
import type { CommandSpec } from '../lib/cli.ts';
import { emit, flag, flagBool } from '../lib/cli.ts';
import { ExitCode, GroceryError } from '../lib/errors.ts';
import type { GroceryConfig } from '../lib/locale.ts';
import { listPacks, loadPack, readConfig, writeConfig } from '../lib/locale.ts';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `3:10` or `wed:10` → `{ day: 3, hour: 10 }`. */
function parseWeekStart(raw: string): { day: number; hour: number } {
  const [left, right, ...extra] = raw.trim().toLowerCase().split(':');
  const bad = (): never => {
    throw new GroceryError(
      `--week-start expects <day>:<hour>, got "${raw}".`,
      {
        code: 'usage',
        exitCode: ExitCode.USAGE,
        hint: 'Day is 0-6 (0 = Sunday) or sun/mon/tue/wed/thu/fri/sat; hour is 0-23. Example: --week-start wed:10',
      },
    );
  };
  if (extra.length > 0 || left === undefined || right === undefined || right === '') bad();

  const named = DAY_NAMES.indexOf(left!.slice(0, 3));
  const day = named >= 0 ? named : Number(left);
  const hour = Number(right);
  if (!Number.isInteger(day) || day < 0 || day > 6) bad();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) bad();
  return { day, hour };
}

interface ConfigView extends GroceryConfig {
  /** Human-readable form of weekStart, so nobody has to remember that 3 is Wednesday. */
  weekStartLabel: string;
  /** Text direction of the active pack — what tells the render paths whether to insert RTL marks. */
  dir: 'rtl' | 'ltr';
  /** Every locale tag this template ships. */
  locales: string[];
}

function view(config: GroceryConfig): ConfigView {
  const pack = loadPack(config.locale);
  return {
    ...config,
    weekStartLabel: `${DAY_NAMES[config.weekStart.day]!} ${String(config.weekStart.hour).padStart(2, '0')}:00`,
    dir: pack.dir,
    locales: listPacks(),
  };
}

export const configCommand: CommandSpec = {
  name: 'config',
  summary: 'read or change the language, the week start and the receipt-corrections switch',
  usage:
    'bun grocery.ts config [--locale <tag>] [--week-start <dow>:<hour>] ' +
    '[--remember-corrections | --no-remember-corrections] [--json]',
  async run(ctx) {
    const patch: Partial<GroceryConfig> = {};

    const locale = flag(ctx.args, 'locale');
    if (locale !== undefined) patch.locale = locale.trim();

    const weekStart = flag(ctx.args, 'week-start');
    if (weekStart !== undefined) patch.weekStart = parseWeekStart(weekStart);

    if ('remember-corrections' in ctx.args.flags) {
      patch.rememberReceiptCorrections = flagBool(ctx.args, 'remember-corrections', true);
    }

    const config = Object.keys(patch).length > 0 ? writeConfig(patch) : readConfig();

    // Only after the write, and only when the language actually moved: this
    // renames the eleven aisles and touches nothing else.
    if (patch.locale !== undefined) seedCategories(loadPack(config.locale));

    emit(ctx, view(config), (data) => {
      console.log(`locale                      ${data.locale}  (${data.dir})`);
      console.log(`weekStart                   ${data.weekStart.day}:${data.weekStart.hour}  (${data.weekStartLabel})`);
      console.log(`rememberReceiptCorrections  ${data.rememberReceiptCorrections}`);
      console.log(`locales available           ${data.locales.join(', ')}`);
    });
  },
};
