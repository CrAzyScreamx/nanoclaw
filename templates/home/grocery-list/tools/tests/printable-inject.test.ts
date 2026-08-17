/**
 * The list actually reaches the page.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * WHAT IS BEING PROTECTED, AND WHY IT NEEDS ITS OWN FILE
 * -----------------------------------------------------
 * `renderSheet` injects the list into `assets/list-template.html` as
 * `window.__LIST__`. It used to do that with `template.replace('</head>', …)`,
 * and `String.replace` with a string pattern replaces the FIRST match — which in
 * that file was the `</head>` written inside its own opening comment. So the
 * payload was injected into a comment, never executed, and the template fell
 * through to the DEMO sample list it carries for direct browsing. Every sheet
 * printed the same English list of somebody else's groceries.
 *
 * It survived because every downstream signal was green. Chromium exited 0, the
 * PDF was a valid non-empty file, `printable --json` printed the correct payload
 * (it never renders), and `SheetResult.items`/`categories` are counted from the
 * payload rather than from the page — so the renderer reported accurate numbers
 * about a sheet that contained none of them. A human comparing the PDF to the
 * list was the only detector, and the one measurable symptom was that two
 * different lists produced byte-identical PDFs.
 *
 * So the assertions here are on the HTML and not on a rendered file: this is the
 * layer where right and wrong are distinguishable, and it needs no chromium.
 */
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { injectList, type SheetList } from '../lib/printable.ts';
import { loadPack } from '../lib/locale.ts';
import { GroceryError } from '../lib/errors.ts';

const TEMPLATE_PATH = path.join(import.meta.dir, '..', 'assets', 'list-template.html');
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const pack = loadPack('he-IL');

const listOf = (...names: string[]): SheetList => ({
  title: 'רשימת קניות',
  date: '16.08.2026',
  dir: 'rtl',
  lang: 'he-IL',
  categories: [{ name: 'חטיפים ומתוקים', items: names.map((name) => ({ name, qty: '1', note: '' })) }],
});

/** Is `offset` inside an HTML comment? True when the last `<!--` beats the last `-->`. */
function insideComment(html: string, offset: number): boolean {
  const before = html.slice(0, offset);
  return before.lastIndexOf('<!--') > before.lastIndexOf('-->');
}

test('the payload lands where a browser will execute it, not inside a comment', () => {
  const html = injectList(template, listOf('אגוזים'), pack);
  const at = html.indexOf('window.__LIST__ =');
  expect(at).toBeGreaterThan(-1);
  // The assertion the old code needed and did not have.
  expect(insideComment(html, at)).toBe(false);
  // Ahead of the closing head TAG — `lastIndexOf`, because the file's opening
  // comment quotes `</head>` while explaining this very bug, and an `indexOf`
  // here would measure against that sentence instead of against the markup.
  expect(at).toBeLessThan(html.lastIndexOf('</head>'));
  // And ahead of the script at the foot of the page that reads the global.
  expect(at).toBeLessThan(html.lastIndexOf('window.__LIST__'));
});

test('the rendered item names are in the HTML the browser is handed', () => {
  const html = injectList(template, listOf('אגוזים', 'אגוזי מלך'), pack);
  const payload = html.slice(html.indexOf('window.__LIST__ ='), html.indexOf('</script>', html.indexOf('window.__LIST__ =')));
  expect(payload).toContain('אגוזים');
  expect(payload).toContain('אגוזי מלך');
  expect(payload).toContain('חטיפים ומתוקים');
});

test('two different lists produce different HTML — the symptom that was visible', () => {
  const a = injectList(template, listOf('אגוזים'), pack);
  const b = injectList(template, listOf('משהו אחר לגמרי'), pack);
  expect(a).not.toBe(b);
  // Specifically: neither carries the other's item.
  expect(a).not.toContain('משהו אחר לגמרי');
  expect(b).not.toContain('אגוזים');
});

test('the template still carries its DEMO fallback, and marks it as a sample', () => {
  // The fallback is wanted — the file is meant to be openable in a browser. What
  // is not wanted is a fallback that looks like a real sheet, so it renames the
  // title. If this is ever removed, a future injection bug goes silent again.
  expect(template).toContain('const DEMO');
  expect(template).toContain('SAMPLE — not a real list');
});

test('the marker appears exactly once, including nowhere in prose', () => {
  // Both halves matter. Zero means the injector cannot find its place; two means
  // one of them is in a comment and the payload may land there — the original bug
  // in a new costume.
  expect(template.split('<!--__LIST_PAYLOAD__-->').length - 1).toBe(1);
});

test('a template without the marker fails loudly instead of rendering a sample', () => {
  const stripped = template.replace('<!--__LIST_PAYLOAD__-->', '');
  let caught: unknown;
  try {
    injectList(stripped, listOf('אגוזים'), pack);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GroceryError);
  expect((caught as GroceryError).code).toBe('pdf_failed');
  // The pack's line is what reaches the group; the diagnostic rides on --json.
  expect((caught as GroceryError).message).toBe(pack.errors.pdfFailed);
  expect((caught as GroceryError).detail).toContain('exactly once, found 0');
});

test('a duplicated marker also fails, rather than picking one', () => {
  const doubled = template.replace('<!--__LIST_PAYLOAD__-->', '<!--__LIST_PAYLOAD__--><!--__LIST_PAYLOAD__-->');
  let caught: unknown;
  try {
    injectList(doubled, listOf('אגוזים'), pack);
  } catch (error) {
    caught = error;
  }
  // The message is the pack's line, deliberately — it is what gets relayed to the
  // group. The diagnostic is in `detail`, for whoever is reading `--json`.
  expect((caught as GroceryError).message).toBe(pack.errors.pdfFailed);
  expect((caught as GroceryError).detail).toContain('exactly once, found 2');
});

test('a name that could close the script tag cannot', () => {
  // `</script>` inside a JSON string would end the injected block early and spill
  // the rest of the payload into the document as markup.
  const html = injectList(template, listOf('milk </script><h1>x</h1>'), pack);
  const block = html.slice(html.indexOf('window.__LIST__ ='));
  expect(block.slice(0, block.indexOf('</script>'))).not.toContain('<h1>');
  expect(block).toContain('\\u003c/script');
});
