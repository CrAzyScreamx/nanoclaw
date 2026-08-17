/**
 * Where rendered sheets go, and how long they last.
 *
 * Deliberately container-local scratch under `/tmp`, NOT the group mount, and
 * deliberately reaped.
 *
 * WHY NOT THE GROUP MOUNT
 * -----------------------
 * A sheet written under the group's own directory survives the container, keeps
 * a predictable name, and stays visible in the agent's conversation history.
 * That combination is a trap: asked to print again, the agent sends that
 * morning's file straight back without rendering anything, and the reply looks
 * perfectly correct. Under `/tmp` the path simply does not exist in the next
 * container, so the shortcut fails loudly ("File not found") instead of
 * returning a stale sheet — a rule the runtime enforces rather than one the
 * agent has to remember. `commands/print.ts` re-renders for the same reason.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { LocalePack } from './locale.ts';
import { t } from './locale.ts';

const SHEET_ROOT = '/tmp/grocery-sheets';
const SHEET_TTL_MS = 10 * 60 * 1000;

/**
 * Delete rendered sheets older than the TTL — on EVERY invocation of every
 * verb, not just `printable`, so a stale sheet is reaped within minutes even
 * inside one long-lived container. The TTL is what keeps a run from deleting
 * the sheet it is about to hand over: rendering and sending are seconds apart,
 * never minutes.
 *
 * `lib/bootstrap.ts` calls this and swallows anything it throws — a sheet that
 * will not delete is never a reason to fail an `add`.
 */
export function reapSheets(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(SHEET_ROOT);
  } catch {
    return; // nothing rendered in this container yet
  }
  const cutoff = Date.now() - SHEET_TTL_MS;
  for (const entry of entries) {
    const full = path.join(SHEET_ROOT, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A sheet vanishing under us is the desired end state, not an error.
    }
  }
}

/**
 * A fresh directory per render, under the reaped scratch root.
 *
 * Unique so one run's sheet can never be mistaken for another's, and the
 * friendly filename is kept because it is what the recipient sees when the file
 * arrives.
 *
 * `sheetFilenameStem` is the ONE localised string that is load-bearing for a
 * file path rather than for a reader, which is why `lib/locale.ts` validates it
 * for path separators at load time. The date's dots, slashes and spaces are
 * replaced here for the same reason — `lib/time.ts` formats it `dd.MM.yyyy` and
 * a slash in a filename is a directory that does not exist.
 */
export function newSheetPath(dateLabel: string, pack: LocalePack): string {
  fs.mkdirSync(SHEET_ROOT, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(SHEET_ROOT, 'run-'));
  const stem = t(pack, 'sheetFilenameStem');
  return path.join(runDir, `${stem}-${dateLabel.replace(/[./\s]/g, '-')}.pdf`);
}
