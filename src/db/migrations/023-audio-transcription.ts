import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  // Renumbered 022 → 023 when upstream claimed 022 for messaging-group-detached.
  // `name` is the applied identity and must never change — it is what keeps this
  // from re-running (and failing on an already-present column) on live DBs.
  name: 'audio-transcription',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN audio_transcription TEXT NOT NULL DEFAULT 'on'").run();
  },
};
