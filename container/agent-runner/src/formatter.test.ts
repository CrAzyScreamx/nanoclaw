/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags, stripLegacyTaskContract } from './formatter.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('task prompt compatibility', () => {
  it('strips the generated #2981 delivery suffix without mutating stored data', () => {
    const prompt =
      'Send the daily digest\n\n' +
      '[A task serves the user two separate ways — legacy generated delivery instructions]';

    expect(stripLegacyTaskContract(prompt)).toBe('Send the daily digest');
  });

  it('strips the generated #2988 delivery suffix', () => {
    const prompt = 'Check the feeds\n\n[Task delivery contract:\nlegacy generated instructions]';

    expect(stripLegacyTaskContract(prompt)).toBe('Check the feeds');
  });

  it('leaves ordinary user prompts unchanged', () => {
    const prompt = 'Explain [Task delivery contract:] as plain text';

    expect(stripLegacyTaskContract(prompt)).toBe(prompt);
  });

  it('does not expose a legacy delivery contract in a formatted task run', () => {
    insertMessage('task-1', 'task', {
      prompt: 'Check the feeds\n\n[Task delivery contract:\nlegacy generated instructions]',
    });

    const result = formatMessages(getPendingMessages());
    expect(result).toContain('Instructions:\nCheck the feeds');
    expect(result).not.toContain('legacy generated instructions');
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('task timestamps', () => {
  it('renders task time in the user TZ, same as chat rows', () => {
    insertMessage('t1', 'task', { prompt: 'do the thing' }, { timestamp: '2026-01-05T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`time="${formatLocalTime('2026-01-05T12:00:00.000Z', TIMEZONE)}"`);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('attachment rendering', () => {
  it('renders a plain file attachment with its saved path', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'here you go',
      attachments: [{ type: 'file', name: 'report.pdf', localPath: 'inbox/m1/report.pdf' }],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[file: report.pdf — saved to /workspace/inbox/m1/report.pdf]');
  });

  it('renders a transcript-less audio attachment exactly as before', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'note.ogg', mimeType: 'audio/ogg', localPath: 'inbox/m1/note.ogg' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[audio: note.ogg — saved to /workspace/inbox/m1/note.ogg]');
    expect(result).not.toContain('transcrib');
    expect(result).not.toContain('<transcript>');
  });

  it('falls back to the url form when there is no localPath', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [{ type: 'image', name: 'pic.png', url: 'https://example.com/pic.png' }],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[image: pic.png (https://example.com/pic.png)]');
  });
});

describe('audio transcripts', () => {
  it('renders the transcript alongside the saved path', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        {
          type: 'audio',
          name: 'note.ogg',
          mimeType: 'audio/ogg',
          size: 12345,
          localPath: 'inbox/m1/note.ogg',
          transcript: 'can you check the deploy?',
          transcriptModel: 'ivrit-turbo',
        },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(
      '[audio: note.ogg — transcribed, saved to /workspace/inbox/m1/note.ogg]\n' +
        '<transcript>can you check the deploy?</transcript>',
    );
  });

  it('renders sensibly when a transcript arrives without a localPath', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'note.ogg', transcript: 'ping me when it is green' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(
      '[audio: note.ogg — transcribed]\n<transcript>ping me when it is green</transcript>',
    );
    expect(result).not.toContain('saved to');
  });

  it('keeps the url form when a transcript arrives with a url but no localPath', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        {
          type: 'audio',
          name: 'note.ogg',
          url: 'https://example.com/note.ogg',
          transcript: 'hello there',
        },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(
      '[audio: note.ogg — transcribed (https://example.com/note.ogg)]\n' +
        '<transcript>hello there</transcript>',
    );
  });

  it('treats an empty transcript as absent', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'note.ogg', localPath: 'inbox/m1/note.ogg', transcript: '' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[audio: note.ogg — saved to /workspace/inbox/m1/note.ogg]');
    expect(result).not.toContain('<transcript>');
    expect(result).not.toContain('transcribed');
  });

  it('treats a whitespace-only transcript as absent', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'note.ogg', localPath: 'inbox/m1/note.ogg', transcript: '   \n\t ' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[audio: note.ogg — saved to /workspace/inbox/m1/note.ogg]');
    expect(result).not.toContain('<transcript>');
    expect(result).not.toContain('transcribed');
  });

  it('ignores a non-string transcript', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'note.ogg', localPath: 'inbox/m1/note.ogg', transcript: 42 },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[audio: note.ogg — saved to /workspace/inbox/m1/note.ogg]');
    expect(result).not.toContain('<transcript>');
  });

  it('XML-escapes transcript content', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        {
          type: 'audio',
          name: 'note.ogg',
          localPath: 'inbox/m1/note.ogg',
          transcript: 'run <script>alert("hi")</script> & then ship it',
        },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(
      '<transcript>run &lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; then ship it</transcript>',
    );
    expect(result).not.toContain('<script>');
  });

  it('trims surrounding whitespace from the transcript', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        {
          type: 'audio',
          name: 'note.ogg',
          localPath: 'inbox/m1/note.ogg',
          transcript: '\n  hey there  \n',
        },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<transcript>hey there</transcript>');
  });

  it('leaves the transcript outside the message body text', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'typed words',
      attachments: [
        {
          type: 'audio',
          name: 'note.ogg',
          localPath: 'inbox/m1/note.ogg',
          transcript: 'spoken words',
        },
      ],
    });
    const result = formatMessages(getPendingMessages());
    const typedIdx = result.indexOf('typed words');
    const spokenIdx = result.indexOf('<transcript>spoken words</transcript>');
    expect(typedIdx).toBeGreaterThan(0);
    expect(spokenIdx).toBeGreaterThan(typedIdx);
    expect(result).toContain('</transcript></message>');
  });

  it('renders each transcript when several audio attachments are present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'audio', name: 'a.ogg', localPath: 'inbox/m1/a.ogg', transcript: 'first note' },
        { type: 'audio', name: 'b.ogg', localPath: 'inbox/m1/b.ogg', transcript: 'second note' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<transcript>first note</transcript>');
    expect(result).toContain('<transcript>second note</transcript>');
    expect(result.indexOf('second note')).toBeGreaterThan(result.indexOf('first note'));
  });

  it('does not transcribe-label a non-audio attachment that lacks a transcript', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: '',
      attachments: [
        { type: 'image', name: 'pic.png', localPath: 'inbox/m1/pic.png' },
        { type: 'audio', name: 'note.ogg', localPath: 'inbox/m1/note.ogg', transcript: 'hi' },
      ],
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[image: pic.png — saved to /workspace/inbox/m1/pic.png]');
    expect(result).toContain('[audio: note.ogg — transcribed, saved to /workspace/inbox/m1/note.ogg]');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});
