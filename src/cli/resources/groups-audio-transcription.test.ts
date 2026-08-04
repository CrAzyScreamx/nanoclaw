/**
 * `--audio-transcription` — the per-agent-group inbound audio switch.
 *
 * Two things are load-bearing and easy to break silently:
 *  1. the flag only accepts `on` / `off` (a typo must fail loudly, not write
 *     an unknown value the reader would then treat as "not on" → transcription
 *     silently off for that group);
 *  2. the switch defaults to ON everywhere — for rows that already existed
 *     before the migration and for rows created afterwards.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-audio' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-audio';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { migrations } from '../../db/migrations/index.js';
import { migration022 } from '../../db/migrations/022-audio-transcription.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

const GID = 'ag-audio';

function now(): string {
  return new Date().toISOString();
}

function reset(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

async function configUpdate(args: Record<string, unknown>) {
  return dispatch({ id: `r-${Math.random()}`, command: 'groups-config-update', args }, { caller: 'host' });
}

describe('groups config update --audio-transcription', () => {
  beforeEach(() => {
    reset();
    runMigrations(initTestDb());
    createAgentGroup({ id: GID, name: 'audio', folder: 'audio', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('a new group starts at on (schema DEFAULT — the column is not in the INSERT list)', () => {
    expect(getContainerConfig(GID)!.audio_transcription).toBe('on');
  });

  it('rejects a bogus value without writing it', async () => {
    const resp = await configUpdate({ id: GID, 'audio-transcription': 'yes-please' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('--audio-transcription must be one of: on, off');
    expect(getContainerConfig(GID)!.audio_transcription).toBe('on');
  });

  it('accepts off and on, and surfaces the value through config get', async () => {
    const off = await configUpdate({ id: GID, 'audio-transcription': 'off' });
    expect(off.ok).toBe(true);
    if (off.ok) expect((off.data as Record<string, unknown>).audio_transcription).toBe('off');
    expect(getContainerConfig(GID)!.audio_transcription).toBe('off');

    // snake_case spelling works too (the container transport hands args through
    // with underscores) — same dual-key handling as --cli-scope.
    const on = await configUpdate({ id: GID, audio_transcription: 'on' });
    expect(on.ok).toBe(true);
    expect(getContainerConfig(GID)!.audio_transcription).toBe('on');

    const get = await dispatch({ id: 'r-get', command: 'groups-config-get', args: { id: GID } }, { caller: 'host' });
    expect(get.ok).toBe(true);
    if (get.ok) expect((get.data as Record<string, unknown>).audio_transcription).toBe('on');
  });

  it('is listed in the "nothing to update" hint', async () => {
    const resp = await configUpdate({ id: GID });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('--audio-transcription');
  });
});

describe('migration 020', () => {
  beforeEach(reset);
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('leaves pre-existing container_configs rows at on', () => {
    const db = initTestDb();
    // Bring the schema up to everything EXCEPT the new column, then seed a row
    // the way a live install would have had one before the upgrade.
    runMigrations(
      db,
      migrations.filter((m) => m.name !== migration022.name),
    );
    createAgentGroup({ id: GID, name: 'legacy', folder: 'legacy', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    expect(db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(GID)).not.toHaveProperty(
      'audio_transcription',
    );

    runMigrations(db, [migration022]);

    expect(getContainerConfig(GID)!.audio_transcription).toBe('on');
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM schema_version WHERE name = ?').get(migration022.name) as { c: number }).c,
    ).toBe(1);
  });
});
