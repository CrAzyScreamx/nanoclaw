/**
 * lib/locale.ts — the language pack and the one config file, in one module.
 *
 * WHY THESE TWO LIVE TOGETHER
 * ---------------------------
 * Choosing a pack is reading the config, and every other module wants the pack
 * rather than the config. Splitting them would put a `readConfig()` call in
 * front of every `loadPack()` call site and make it possible to load the wrong
 * pack by forgetting one. Nothing outside this file touches `config.json` or
 * the `locales/` directory.
 *
 * WHAT IS IN CONFIG AND WHAT IS NOT
 * ---------------------------------
 *   locale                      which pack: 'he-IL' | 'en-US' | any shipped tag
 *   weekStart {day, hour}       when the shopping week turns over, day 0 = Sunday
 *   rememberReceiptCorrections  opt-in, offered once at welcome
 *
 * That is the whole file. The timezone is NOT here — it comes from the
 * container's `TZ` (see lib/time.ts). No credential is here either, and none
 * ever will be: this template sends no auth header at all, because the OneCLI
 * gateway injects credentials at the proxy boundary.
 *
 * `config.json` is written by `SETUP.md` on the host before the group is ever
 * wired, and by `grocery.ts config` afterwards. Writes are atomic (temp file +
 * rename) so a container killed mid-write leaves the old file intact rather
 * than a truncated one.
 *
 * THE PACK IS DATA, NOT CODE
 * --------------------------
 * Everything a person can see — every heading, every confirmation, the aisle
 * names, both classifier prompts, even the stem of the PDF filename — lives in
 * `locales/<tag>.json`. Adding a language is adding one JSON file, with no code
 * change. `locale.test.ts` asserts every pack carries the same keys, so a
 * missing string is a test failure rather than a hole in a sent message.
 *
 * A pack file is READ from the plugin directory, which is mounted read-only.
 * Reading is allowed there; writing is not, and nothing here writes to it.
 *
 * **`sheetFilenameStem` is the one localised string that is load-bearing for a
 * file PATH.** It must stay filesystem-safe: no `/`, no separators, nothing a
 * shell would split. Everything else in the pack is display text and can say
 * whatever a language needs.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_DIR } from './db.ts';
import { ExitCode, GroceryError } from './errors.ts';

export interface GroceryConfig {
  /** 'he-IL' | 'en-US' | any tag with a file in tools/locales/. */
  locale: string;
  /** day 0 = Sunday … 6 = Saturday; hour 0-23, container-local. */
  weekStart: { day: number; hour: number };
  /**
   * Whether the receipt reader may write what it misread into the group memory
   * tree. Opt-in, offered once by the welcome skill and off until then — a
   * receipt carries what a household actually eats, and remembering any of it
   * is the group's decision, not the agent's.
   */
  rememberReceiptCorrections: boolean;
}

export interface LocalePack {
  tag: string;
  dir: 'rtl' | 'ltr';
  categories: { key: string; name: string; sort: number; catchAll?: boolean }[];
  /** Every user-visible line the render paths emit. */
  strings: Record<string, string>;
  /** Lines print.ts / printable.ts relay verbatim. */
  errors: Record<string, string>;
  /** The two classifier system prompts. */
  prompts: { aisle: string; identity: string };
}

export const CONFIG_PATH = `${STATE_DIR}/config.json`;

/**
 * The pack directory, resolved against this file — a READ into the read-only mount.
 *
 * `fileURLToPath` rather than `.pathname`: a URL keeps the path percent-encoded,
 * so a checkout under a directory with a space or a non-ASCII character yields
 * `…/space%20test/tools/locales/`, `readdirSync` throws, `listPacks()` comes
 * back empty and EVERY verb dies at `loadPack()` with "(none found)". The
 * container mount has no such character, but a developer's checkout easily can.
 */
const PACK_DIR = fileURLToPath(new URL('../locales/', import.meta.url));

/**
 * Defaults when `config.json` is absent, which is the state of a freshly
 * stamped group that has not been through `SETUP.md` yet.
 *
 * `en-US` rather than the language this tool was first written in: a template
 * in a public catalog is stamped by people who have not read it, and a list
 * that greets them in a language they do not speak is not a working default.
 * `SETUP.md` step 2 asks and writes the answer before anyone is wired.
 *
 * Wednesday 10:00 is the source group's boundary, kept because it is a good
 * one: the week turns over mid-morning midweek, which leaves the review
 * question a window to be asked in before the rollover it is about.
 */
const DEFAULTS: GroceryConfig = {
  locale: 'en-US',
  weekStart: { day: 3, hour: 10 },
  rememberReceiptCorrections: false,
};

// ------------------------------------------------------------------ plumbing

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw new GroceryError(
      `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'config_write_failed', exitCode: ExitCode.UNEXPECTED },
    );
  }
}

// -------------------------------------------------------------------- config

/**
 * The config as it is on disk, with documented defaults for anything missing.
 *
 * A corrupt or half-written file must never take a verb down — the list still
 * works in the default language, which is a far better failure than an `add`
 * that throws. Read it fresh every call: `config --locale` writes it and the
 * very next line re-seeds category names from the new pack.
 */
export function readConfig(): GroceryConfig {
  let stored: Partial<GroceryConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8').trim();
      if (raw) stored = JSON.parse(raw) as Partial<GroceryConfig>;
    } catch {
      stored = {};
    }
  }
  const week = stored.weekStart;
  return {
    locale: typeof stored.locale === 'string' && stored.locale.trim() ? stored.locale.trim() : DEFAULTS.locale,
    weekStart: {
      day: isDay(week?.day) ? week!.day : DEFAULTS.weekStart.day,
      hour: isHour(week?.hour) ? week!.hour : DEFAULTS.weekStart.hour,
    },
    rememberReceiptCorrections:
      typeof stored.rememberReceiptCorrections === 'boolean'
        ? stored.rememberReceiptCorrections
        : DEFAULTS.rememberReceiptCorrections,
  };
}

function isDay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

function isHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/**
 * Merge a patch into `config.json` and return the result.
 *
 * Validated here rather than at the flag, so a hand-edited file gets the same
 * refusal the `config` verb does. A rejected write leaves the old file exactly
 * as it was.
 */
export function writeConfig(patch: Partial<GroceryConfig>): GroceryConfig {
  const current = readConfig();

  if (patch.locale !== undefined) {
    // Fails loudly on an unknown tag: a typo that silently fell back to the
    // default would show up weeks later as a list in the wrong language.
    loadPack(patch.locale);
  }
  if (patch.weekStart !== undefined) {
    const { day, hour } = patch.weekStart;
    if (!isDay(day) || !isHour(hour)) {
      throw new GroceryError(
        `Week start must be a day 0-6 (0 = Sunday) and an hour 0-23, got ${JSON.stringify(patch.weekStart)}.`,
        { code: 'usage', exitCode: ExitCode.USAGE, hint: 'Example: --week-start 3:10 for Wednesday at 10:00.' },
      );
    }
  }

  const merged: GroceryConfig = {
    ...current,
    ...patch,
    weekStart: patch.weekStart ? { ...patch.weekStart } : current.weekStart,
  };
  writeAtomic(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// --------------------------------------------------------------------- packs

/** Every locale tag shipped in `tools/locales/`, sorted. */
export function listPacks(): string[] {
  try {
    return readdirSync(PACK_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

const cache = new Map<string, LocalePack>();

/**
 * Load a pack by tag, or the configured one.
 *
 * Cached per process: `bootstrap`, a verb and its render path all ask for the
 * same pack, and re-reading and re-parsing the file three times per invocation
 * is work with no upside.
 */
export function loadPack(tag?: string): LocalePack {
  const wanted = (tag ?? readConfig().locale).trim();
  const cached = cache.get(wanted);
  if (cached) return cached;

  // A tag names a file, so anything path-shaped is refused rather than resolved.
  if (!/^[A-Za-z0-9_-]+$/.test(wanted)) {
    throw unknownTag(wanted);
  }
  const file = `${PACK_DIR}${wanted}.json`;
  if (!existsSync(file)) throw unknownTag(wanted);

  let parsed: LocalePack;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as LocalePack;
  } catch (error) {
    throw new GroceryError(
      `Locale pack ${wanted}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'locale_pack_invalid', exitCode: ExitCode.UNEXPECTED },
    );
  }
  validate(wanted, parsed);
  cache.set(wanted, parsed);
  return parsed;
}

function unknownTag(tag: string): GroceryError {
  const have = listPacks();
  return new GroceryError(
    `Unknown locale "${tag}". This template ships: ${have.join(', ') || '(none found)'}.`,
    {
      code: 'unknown_locale',
      exitCode: ExitCode.USAGE,
      hint: 'Adding a language is adding one file to tools/locales/ — no code changes.',
    },
  );
}

/**
 * Enough of a shape check that a broken pack fails at load with a sentence
 * naming the file, instead of as `undefined` in the middle of a rendered list.
 */
function validate(tag: string, pack: LocalePack): void {
  const bad = (why: string): never => {
    throw new GroceryError(`Locale pack ${tag}.json is unusable: ${why}.`, {
      code: 'locale_pack_invalid',
      exitCode: ExitCode.UNEXPECTED,
    });
  };
  if (pack.dir !== 'rtl' && pack.dir !== 'ltr') bad('"dir" must be "rtl" or "ltr"');
  if (!Array.isArray(pack.categories) || pack.categories.length === 0) bad('"categories" is empty');
  if (pack.categories.filter((c) => c.catchAll).length !== 1) {
    bad('exactly one category must be marked "catchAll": true');
  }
  for (const category of pack.categories) {
    if (!category.key || !category.name || typeof category.sort !== 'number') {
      bad(`category ${JSON.stringify(category)} needs key, name and sort`);
    }
  }
  if (!pack.strings || typeof pack.strings !== 'object') bad('"strings" is missing');
  if (!pack.errors || typeof pack.errors !== 'object') bad('"errors" is missing');
  if (!pack.prompts?.aisle || !pack.prompts?.identity) bad('"prompts" needs aisle and identity');
  // The one string that names a file rather than being read by a person.
  const stem = pack.strings.sheetFilenameStem;
  if (!stem || /[/\\]/.test(stem)) bad('"sheetFilenameStem" must be present and contain no path separators');
}

/**
 * One line from the pack, with `{placeholders}` filled in.
 *
 * A missing key THROWS rather than rendering the key name or an empty string.
 * A silent gap here is a message sent to the group with a hole in it, which is
 * exactly the class of failure the packs exist to prevent; `locale.test.ts`
 * asserts both packs carry the same keys so the throw is a build-time problem
 * rather than a runtime one.
 */
export function t(pack: LocalePack, key: string, vars?: Record<string, string | number>): string {
  const template = pack.strings[key] ?? pack.errors[key];
  if (template === undefined) {
    throw new GroceryError(`Locale pack ${pack.tag} has no string "${key}".`, {
      code: 'locale_key_missing',
      exitCode: ExitCode.UNEXPECTED,
      hint: 'Add it to every file in tools/locales/, not just one.',
    });
  }
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The catch-all aisle in a pack — the destination for anything unclassified. */
export function catchAllCategory(pack: LocalePack): { key: string; name: string; sort: number } {
  const hit = pack.categories.find((c) => c.catchAll);
  // validate() already guaranteed exactly one; the fallback is for a pack that
  // was hand-edited between load and use.
  return hit ?? pack.categories[pack.categories.length - 1]!;
}
