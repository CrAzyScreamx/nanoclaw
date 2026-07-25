/**
 * Contract tests for the router's audio-transcription seam.
 *
 * The seam is exercised through `routeInbound` (the real fanout path) with
 * `writeSessionMessage` spied, so what the seam actually hands to the inbound
 * DB is asserted directly. Everything else — DB, session resolution, engage
 * evaluation — is the real thing, reusing the host-core fixture shape.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import type { InboundEvent } from './channels/adapter.js';

// No Docker in tests.
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-audio-seam';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-audio-seam' };
});

// Partial mock: real session resolution, spied writeSessionMessage. The spy is
// the assertion surface — it sees the exact `content` the seam produced,
// before extractAttachmentFiles would rewrite it.
const mockWriteSessionMessage = vi.fn();
vi.mock('./session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./session-manager.js')>('./session-manager.js');
  return { ...actual, writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args) };
});

function now() {
  return new Date().toISOString();
}

const ORIGINAL_ID = 'msg-audio-1';
const ORIGINAL_CONTENT = JSON.stringify({ sender: 'User', text: '', attachments: [{ type: 'audio', data: 'AAAA' }] });

function audioEvent(): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'chan-audio',
    threadId: null,
    message: {
      id: ORIGINAL_ID,
      kind: 'chat',
      content: ORIGINAL_CONTENT,
      timestamp: now(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  for (const [id, folder] of [
    ['ag-1', 'audio-agent-1'],
    ['ag-2', 'audio-agent-2'],
  ]) {
    createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
  }
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-audio',
    name: 'Voice',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const [id, agentGroupId] of [
    ['mga-1', 'ag-1'],
    ['mga-2', 'ag-2'],
  ]) {
    createMessagingGroupAgent({
      id,
      messaging_group_id: 'mg-1',
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// The transcriber slot is module-level and registration is one-way, so the
// unregistered case has to run before anything registers. Once registered, the
// single hook delegates to `impl`, which each later test swaps out — that also
// keeps the "overwritten" warning out of the way.
let impl: ((content: string, ctx: { agentGroupId: string; messageId: string }) => Promise<string>) | null = null;

describe('router audio-transcription seam', () => {
  it('passes content through verbatim when no transcriber is registered', async () => {
    const { routeInbound, hasAudioTranscriber } = await import('./router.js');
    expect(hasAudioTranscriber()).toBe(false);

    await routeInbound(audioEvent());

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    for (const call of mockWriteSessionMessage.mock.calls) {
      expect(call[2].content).toBe(ORIGINAL_CONTENT);
    }
  });

  it('writes the transcriber return value once registered', async () => {
    const { routeInbound, setAudioTranscriber, hasAudioTranscriber } = await import('./router.js');
    setAudioTranscriber((content, ctx) => (impl ? impl(content, ctx) : Promise.resolve(content)));
    expect(hasAudioTranscriber()).toBe(true);

    const rewritten = JSON.stringify({ sender: 'User', text: 'hello from the voice note' });
    impl = async () => rewritten;

    await routeInbound(audioEvent());

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    for (const call of mockWriteSessionMessage.mock.calls) {
      expect(call[2].content).toBe(rewritten);
    }
  });

  it('falls back to the original content when the transcriber throws', async () => {
    const { routeInbound } = await import('./router.js');
    impl = async () => {
      throw new Error('voicebox unreachable');
    };

    await routeInbound(audioEvent());

    // Message still routes — a transcription failure must never drop it.
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    for (const call of mockWriteSessionMessage.mock.calls) {
      expect(call[2].content).toBe(ORIGINAL_CONTENT);
    }
  });

  it('falls back when the transcriber rejects asynchronously', async () => {
    const { routeInbound } = await import('./router.js');
    impl = () => Promise.reject(new Error('timed out'));

    await routeInbound(audioEvent());

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    for (const call of mockWriteSessionMessage.mock.calls) {
      expect(call[2].content).toBe(ORIGINAL_CONTENT);
    }
  });

  it('passes the ORIGINAL message id in ctx, not the per-agent namespaced id', async () => {
    const { routeInbound } = await import('./router.js');
    const seen: Array<{ agentGroupId: string; messageId: string }> = [];
    impl = async (content, ctx) => {
      seen.push(ctx);
      return content;
    };

    await routeInbound(audioEvent());

    // One call per engaging agent group, each carrying the SAME original id —
    // that identity is what lets the module memoize and transcribe once.
    expect(seen).toHaveLength(2);
    for (const ctx of seen) {
      expect(ctx.messageId).toBe(ORIGINAL_ID);
      expect(ctx.messageId).not.toContain(':');
    }
    expect(seen.map((c) => c.agentGroupId).sort()).toEqual(['ag-1', 'ag-2']);

    // ...while the row id written to the session DB stays namespaced.
    for (const call of mockWriteSessionMessage.mock.calls) {
      expect(call[2].id).toBe(`${ORIGINAL_ID}:${call[0]}`);
    }
  });

  // The seam sits below the command gate so filtered/denied messages never
  // pay for a transcription. '/clear' is denied for a null (unprivileged) user.
  it('does not consult the transcriber for messages the command gate stops', async () => {
    const { routeInbound } = await import('./router.js');
    let calls = 0;
    impl = async (content) => {
      calls++;
      return content;
    };

    await routeInbound({
      ...audioEvent(),
      message: {
        id: 'msg-filtered',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '/clear' }),
        timestamp: now(),
      },
    });

    expect(calls).toBe(0);
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });
});
