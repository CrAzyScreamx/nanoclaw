/**
 * `print --yes` — what it puts on paper, and what it says afterwards.
 *
 *   cd home/grocery-list/tools && bun test
 *
 * WHAT IS BEING PROTECTED
 * -----------------------
 * The success reply is rendered by the CLI and forwarded verbatim, exactly like
 * `add`'s `confirm.line` and `message`'s `text`. It has to be in the `--json`
 * payload for that to be possible: `printSubmitted` used to be rendered in the
 * HUMAN branch only, so an assistant running `print --yes --json` received
 * `{queue, job, copies, pages, path}` and no sentence — and wrote its own. What
 * reached the group was
 *
 *     ✓ שלחתי להדפסה: 1 עמודים לcode canon (job canon-13)
 *
 * mangled, half in English, and leading with the job id, which is an operator's
 * handle for `lpstat` and reads like an error code in a family chat.
 *
 * So: `data.text` exists, it is the pack's line, it names the queue, and it does
 * NOT carry the job id — while `data.job` still does, for whoever is debugging a
 * queue.
 *
 * HOW IT RUNS WITHOUT A PRINTER
 * -----------------------------
 * Every external binary this path uses is resolved through the environment, so
 * all three are stubbed: `lpstat`/`lp` via a PATH shim, and chromium via
 * `AGENT_BROWSER_EXECUTABLE_PATH`. The fake chromium writes a one-page PDF so
 * `countPdfPages` has something real to read. Nothing here touches a queue.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dir, '..', 'grocery.ts');
const QUEUE = 'canon';
const JOB_ID = 'canon-13';

let home = '';
let binDir = '';

/** A one-page PDF, enough for `countPdfPages` to answer 1. */
const FAKE_PDF = [
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n');

function writeStub(name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-print-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bin-'));

  // One queue, and it is the default — so `resolveQueue` needs no --queue.
  writeStub('lpstat', `echo "printer ${QUEUE} is idle.  enabled since now"\necho "system default destination: ${QUEUE}"`);
  // `lp` answers in the shape the verb parses the id out of.
  writeStub('lp', `echo "request id is ${JOB_ID} (1 file(s))"`);
  // Chromium is asked for `--print-to-pdf=<path>`; write a PDF there.
  writeStub(
    'chromium-stub',
    [
      'out=""',
      'for arg in "$@"; do',
      '  case "$arg" in --print-to-pdf=*) out="${arg#--print-to-pdf=}";; esac',
      'done',
      '[ -n "$out" ] || exit 1',
      `cat > "$out" <<'PDF'\n${FAKE_PDF}\nPDF`,
    ].join('\n'),
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MARKET_HOME: home,
      MARKETY_CLASSIFY_DISABLED: '1',
      AGENT_BROWSER_EXECUTABLE_PATH: path.join(binDir, 'chromium-stub'),
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 0 };
}

function json<T = any>(...args: string[]): T {
  const res = run(...args, '--json');
  const parsed = JSON.parse(res.stdout) as { ok: boolean; data: T };
  expect(parsed.ok, `expected ok, got ${res.stdout}${res.stderr}`).toBe(true);
  return parsed.data;
}

interface Submitted {
  text: string;
  queue: string;
  job: string;
  copies: number;
  pages: number | null;
  path: string;
}

function seed(locale: string): void {
  expect(run('config', '--locale', locale).status).toBe(0);
  expect(run('add', '--name', locale === 'he-IL' ? 'אגוזים' : 'hazelnuts').status).toBe(0);
}

test('--json carries the finished sentence, so nothing has to be composed', () => {
  seed('he-IL');
  const data = json<Submitted>('print', '--yes');

  expect(typeof data.text).toBe('string');
  expect(data.text.length).toBeGreaterThan(0);
  // It is the pack's line about this queue.
  expect(data.text).toContain(QUEUE);
  // And the human branch prints exactly the same string, so the two can never drift.
  expect(run('add', '--name', 'עוד משהו').status).toBe(0);
  expect(run('print', '--yes').stdout.trim()).toBe(data.text.trim());
});

test('the job id is in the payload but never in the sentence', () => {
  seed('he-IL');
  const data = json<Submitted>('print', '--yes');

  // Operators need it.
  expect(data.job).toBe(JOB_ID);
  // The group does not: it means nothing in a chat and reads like an error code.
  expect(data.text).not.toContain(JOB_ID);
  expect(data.text.toLowerCase()).not.toContain('job');
  expect(data.text).not.toContain('מזהה');
});

test('the sentence is in the configured language, in both packs', () => {
  seed('he-IL');
  const he = json<Submitted>('print', '--yes').text;
  expect(he).toMatch(/[֐-׿]/); // contains Hebrew
  expect(he).not.toContain(JOB_ID);

  seed('en-US');
  const en = json<Submitted>('print', '--yes').text;
  expect(en).not.toMatch(/[֐-׿]/);
  expect(en).toContain(QUEUE);
  expect(en).not.toContain(JOB_ID);
  expect(he).not.toBe(en);
});

test('the rest of the payload still reports the job accurately', () => {
  seed('en-US');
  const data = json<Submitted>('print', '--yes', '--copies', '2');
  expect(data.queue).toBe(QUEUE);
  expect(data.copies).toBe(2);
  expect(data.pages).toBe(1);
  expect(data.path).toContain('/tmp/grocery-sheets/');
  expect(fs.existsSync(data.path)).toBe(true);
});

test('without --yes it still refuses, and that line names pages and queue', () => {
  seed('he-IL');
  const res = run('print', '--json');
  expect(res.status).toBe(6);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; error: { code: string; message: string } };
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe('confirm_required');
  // The refusal is the question the group answers, so it DOES carry the count.
  expect(parsed.error.message).toContain('1');
  expect(parsed.error.message).toContain(QUEUE);
  // No job exists yet, so there is nothing to leak.
  expect(parsed.error.message).not.toContain(JOB_ID);
});

test('neither pack leaves a {job} placeholder in the submitted line', () => {
  // A pack is data, and a stale `{job}` there would print literally.
  for (const tag of ['he-IL', 'en-US']) {
    const pack = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'locales', `${tag}.json`), 'utf8'));
    expect(pack.strings.printSubmitted).toContain('{queue}');
    expect(pack.strings.printSubmitted).not.toContain('{job}');
  }
});
