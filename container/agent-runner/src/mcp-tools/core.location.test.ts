/**
 * Tests for the send_location MCP tool.
 *
 * Two things matter beyond the happy path. First, the `text` field in the blob
 * is load-bearing, not decorative: adapters that don't implement the `location`
 * operation fall through to the plain-text delivery path, so dropping `text`
 * would make every non-WhatsApp channel silently send nothing. Second, the
 * coordinate validation is the tool's own — JSON Schema `type: number` is not
 * enforced at the call boundary, so a model passing "32.0853" or a swapped
 * lat/lon has to be rejected here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendLocation, formatLocationText } from './core.js';

/** The single outbound blob written by the call under test. */
function soleOutboundContent(): Record<string, unknown> {
  const out = getUndeliveredMessages();
  expect(out).toHaveLength(1);
  return JSON.parse(out[0].content) as Record<string, unknown>;
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('family', 'Family', 'channel', 'whatsapp', '120363@g.us', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_location MCP tool', () => {
  it('writes a location operation routed to the named destination', async () => {
    const res = await sendLocation.handler({ to: 'family', latitude: 32.0853, longitude: 34.7818 });
    expect(res.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out[0].channel_type).toBe('whatsapp');
    expect(out[0].platform_id).toBe('120363@g.us');

    expect(JSON.parse(out[0].content)).toMatchObject({
      operation: 'location',
      latitude: 32.0853,
      longitude: 34.7818,
    });
  });

  it('ships a maps-link text fallback for adapters without native pins', () => {
    // Asserted through the shared formatter so the contract is one string,
    // not two that can drift apart.
    expect(formatLocationText({ latitude: 32.0853, longitude: 34.7818 })).toBe(
      'https://maps.google.com/?q=32.0853,34.7818',
    );
    expect(formatLocationText({ latitude: 1, longitude: 2, name: 'Office', address: 'Main St 1' })).toBe(
      'Office — Main St 1\nhttps://maps.google.com/?q=1,2',
    );
  });

  it('includes that fallback in the written blob', async () => {
    await sendLocation.handler({ to: 'family', latitude: 32.0853, longitude: 34.7818, name: 'Office' });
    expect(soleOutboundContent().text).toBe('Office\nhttps://maps.google.com/?q=32.0853,34.7818');
  });

  it('omits name and address when not supplied', async () => {
    await sendLocation.handler({ to: 'family', latitude: 1, longitude: 2 });
    const content = soleOutboundContent();
    expect(content).not.toHaveProperty('name');
    expect(content).not.toHaveProperty('address');
  });

  it('accepts numeric strings from a model that ignored the schema', async () => {
    const res = await sendLocation.handler({ to: 'family', latitude: '32.0853', longitude: '34.7818' });
    expect(res.isError).toBeUndefined();
    expect(soleOutboundContent().latitude).toBe(32.0853);
  });

  it('rejects out-of-range coordinates instead of sending a bogus pin', async () => {
    for (const args of [
      { to: 'family', latitude: 91, longitude: 0 },
      { to: 'family', latitude: 0, longitude: 181 },
      { to: 'family', latitude: 'somewhere', longitude: 0 },
    ]) {
      const res = await sendLocation.handler(args);
      expect(res.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unknown destination', async () => {
    const res = await sendLocation.handler({ to: 'nobody', latitude: 1, longitude: 2 });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
