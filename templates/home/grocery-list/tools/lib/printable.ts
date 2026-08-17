/**
 * lib/printable.ts — turn a categorised shopping list into a printable A4 PDF.
 *
 * This is the RENDERER, not a verb. `commands/print.ts` is what produces a
 * sheet from the actual list: it reads the week, sorts into aisles, and hands
 * the payload in here.
 *
 * The payload is the LIST shape `assets/list-template.html` expects:
 *   { title, date, dir, lang,
 *     categories: [ { name, items: [ { name, qty, note } ] } ] }
 *
 * An item's `note` is the product qualifier off the database row — "5%",
 * "250 g", "low sodium". It is printed beside the name because it is what tells
 * the shopper which product to reach for; dropping it made the sheet ambiguous
 * exactly where the list was most specific.
 *
 * FONTS AND THE BROWSER
 * ---------------------
 * Renders through the Chromium already in the NanoClaw container image
 * (`AGENT_BROWSER_EXECUTABLE_PATH`, falling back to `/usr/bin/chromium`) — do
 * NOT add a package for it. The HTML template carries its own fonts as `data:`
 * URIs, because the image has no Hebrew-capable font installed (`fc-list
 * :lang=he` is empty) and network egress at print time goes through a proxy, so
 * anything relying on system fonts or a webfont CDN would print Hebrew as empty
 * boxes. Both font sets ship in one file for that reason; the Hebrew faces are
 * 11 KB of the 112 KB total, which is not a saving worth a broken sheet.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExitCode, GroceryError } from './errors.ts';
import { t, type LocalePack } from './locale.ts';

const TEMPLATE = new URL('../assets/list-template.html', import.meta.url).pathname;
const CHROMIUM = process.env.AGENT_BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium';

export interface SheetItem {
  name: string;
  qty: string;
  note: string;
}

export interface SheetCategory {
  name: string;
  items: SheetItem[];
}

export interface SheetList {
  title: string;
  date: string;
  /** Paragraph direction for the sheet — straight from `pack.dir`. */
  dir: 'rtl' | 'ltr';
  /** BCP-47 tag for the `lang` attribute, so hyphenation and fonts match. */
  lang: string;
  categories: SheetCategory[];
}

export interface SheetResult {
  path: string;
  bytes: number;
  items: number;
  categories: number;
}

/**
 * The one failure line this module raises, straight from the pack.
 *
 * The renderer's own output goes in `detail`, not `hint`, so stderr stays a
 * SINGLE line: the agent is told to relay it to the group as-is, and an English
 * chromium stack underneath it would be relayed too. The diagnostic is still
 * one `--json` away for whoever is actually debugging the render.
 */
function pdfFailed(pack: LocalePack, detail: string): GroceryError {
  return new GroceryError(t(pack, 'pdfFailed'), {
    code: 'pdf_failed',
    exitCode: ExitCode.UNEXPECTED,
    detail: detail.slice(-400),
  });
}

/**
 * The one place the template is edited, and the token it is edited at.
 *
 * It used to be `'</head>'`, and that was a silent catastrophe. `String.replace`
 * with a STRING pattern replaces the first match only, and the first `</head>` in
 * the template was the one inside its own opening comment \u2014 so the payload script
 * was injected into a comment, never ran, `window.__LIST__` stayed undefined, and
 * the template fell through to its built-in DEMO list. Every sheet printed the
 * same English sample of somebody else's groceries, and printed it beautifully.
 *
 * Nothing about it was detectable downstream: chromium succeeded, the file was
 * non-empty, and `SheetResult.items`/`categories` are counted from the PAYLOAD and
 * not from the rendered page, so they reported correct numbers about a sheet that
 * did not contain them. The only symptom was that two different lists rendered to
 * byte-identical PDFs.
 *
 * Hence a marker that appears exactly once and means nothing else, and the two
 * assertions in `injectList`: one that it was there, one that it is gone.
 */
const PAYLOAD_MARKER = '<!--__LIST_PAYLOAD__-->';

/**
 * Put `list` into `template` as the `window.__LIST__` global, or throw.
 *
 * Exported and separate from the render so it can be tested without chromium.
 * This is the step that broke, and no test that renders a PDF can see the
 * difference \u2014 the output is a valid, pretty, wrong sheet. Only a test on the
 * HTML catches it.
 */
export function injectList(template: string, list: SheetList, pack: LocalePack): string {
  const markers = template.split(PAYLOAD_MARKER).length - 1;
  if (markers !== 1) {
    throw pdfFailed(pack, `the template must carry ${PAYLOAD_MARKER} exactly once, found ${markers}`);
  }

  // `JSON.stringify` output is escaped for a <script> context: `</script>` inside
  // a string would otherwise close the tag, and U+2028/U+2029 are raw line breaks
  // in JS source.
  const payload = JSON.stringify(list)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const html = template.replace(PAYLOAD_MARKER, `<script>window.__LIST__ = ${payload};</script>`);

  // The marker is gone, so the replace landed. The old guard asked whether
  // `window.__LIST__` appeared anywhere, which can never fail: the template's own
  // comment and its consuming script both contain that name.
  if (html.includes(PAYLOAD_MARKER)) throw pdfFailed(pack, 'the list payload was not injected');
  return html;
}

/**
 * Render a list to `outPath` and return what was written.
 *
 * Throws a `GroceryError` carrying `pack.errors.pdfFailed` on any failure, with
 * the underlying cause in `detail` — the message is relayed to the group as-is,
 * the detail is for whoever is reading `--json`.
 *
 * The payload is built field by field by `commands/print.ts`, which refuses an
 * empty week before it gets here, so the only shape check worth keeping is the
 * one that would otherwise render a blank page.
 *
 * **`items` and `categories` in the result are counted from `list`, not from the
 * rendered page.** They describe what was asked for, and cannot confirm what came
 * out — which is exactly how the injection bug above went unnoticed. Anything
 * verifying the OUTPUT has to compare two different lists, or read the HTML.
 */
export function renderSheet(list: SheetList, outPath: string, pack: LocalePack): SheetResult {
  if (list.categories.length === 0) throw pdfFailed(pack, 'the payload has no categories');

  if (!fs.existsSync(TEMPLATE)) throw pdfFailed(pack, `the print template is missing at ${TEMPLATE}`);
  const html = injectList(fs.readFileSync(TEMPLATE, 'utf8'), list, pack);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'printable-'));
  const htmlPath = path.join(workdir, 'list.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const res = spawnSync(
    CHROMIUM,
    [
      '--headless',
      '--no-sandbox', // no user namespaces inside the agent container
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--user-data-dir=${path.join(workdir, 'profile')}`,
      // The sheet is built by JS on load; give it time to run and the embedded
      // fonts time to decode before the snapshot is taken.
      '--virtual-time-budget=15000',
      '--run-all-compositor-stages-before-draw',
      // Load-bearing, and version-sensitive: recent Chromium silently IGNORES
      // the older --print-to-pdf-no-header and stamps the date, document title
      // and source file:// URL into the page margins. --no-pdf-header-footer is
      // the flag it actually honours. Both are passed so neither rename breaks
      // it. If a future bump reintroduces the stamps, this is the line to look
      // at.
      '--no-pdf-header-footer',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${outPath}`,
      `file://${htmlPath}`,
    ],
    { encoding: 'utf8', timeout: 90_000 },
  );

  fs.rmSync(workdir, { recursive: true, force: true });

  if (res.error || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw pdfFailed(pack, String(res.error || res.stderr || 'chromium produced no file'));
  }

  return {
    path: outPath,
    bytes: fs.statSync(outPath).size,
    items: list.categories.reduce((n, c) => n + c.items.length, 0),
    categories: list.categories.length,
  };
}

/**
 * How many pages a rendered PDF has, or `null` when the file cannot be read
 * that way.
 *
 * `print` names this number in the confirmation it refuses on, so it is worth
 * getting from the file rather than estimating from the item count. There is no
 * PDF tooling in the container image, so it is read off the bytes: the page
 * tree's `/Count` first, and a count of `/Type /Page` objects as a fallback.
 *
 * `null` rather than a guess when neither works. The confirmation then says the
 * page count is unknown, which is honest; a made-up "1" on a four-page list is
 * exactly the sort of quiet wrongness a confirmation exists to prevent.
 */
export function countPdfPages(pdfPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pdfPath, 'latin1');
  } catch {
    return null;
  }
  // The page tree root carries the authoritative total. Both key orders occur
  // in the wild, and an intermediate node's /Count covers only its own subtree,
  // so take the largest of whatever is found.
  const counts = [
    ...raw.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,200}?\/Count\s+(\d+)/g),
    ...raw.matchAll(/\/Count\s+(\d+)[\s\S]{0,200}?\/Type\s*\/Pages\b/g),
  ].map((m) => Number(m[1]));
  const fromTree = counts.length > 0 ? Math.max(...counts) : 0;
  if (fromTree > 0) return fromTree;
  // `/Page` and not `/Pages` — the negative lookahead is the whole difference.
  const pages = raw.match(/\/Type\s*\/Page(?![s\w])/g);
  return pages && pages.length > 0 ? pages.length : null;
}
