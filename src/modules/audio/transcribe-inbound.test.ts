/**
 * Tests for ingest-time audio transcription.
 *
 * Two invariants get explicit guards here because breaking either is silent
 * and destructive:
 *   1. `att.data` survives untouched — the session-manager stages those bytes
 *      to disk AFTER this runs.
 *   2. When nothing is transcribed the ORIGINAL content string comes back
 *      byte-for-byte, so non-audio traffic is unchanged by the feature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({
  url: 'http://voicebox.local:8000',
  model: 'whisper-ivrit-turbo',
  language: 'he',
  fallbackModel: '',
  timeoutMs: 60000,
}));

const dbState = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../../config.js', () => ({
  get VOICEBOX_URL() {
    return configState.url;
  },
  get VOICEBOX_STT_MODEL() {
    return configState.model;
  },
  get VOICEBOX_STT_LANGUAGE() {
    return configState.language;
  },
  get VOICEBOX_STT_FALLBACK_MODEL() {
    return configState.fallbackModel;
  },
  get VOICEBOX_TIMEOUT_MS() {
    return configState.timeoutMs;
  },
}));

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: vi.fn(() => dbState.row),
}));

import { __clearTranscriptCache, isOffLanguage, transcribeContent } from './transcribe-inbound.js';

const B64 = Buffer.from('fake-audio-bytes').toString('base64');

let fetchMock: ReturnType<typeof vi.fn>;
let msgCounter = 0;

function ctx(overrides: Partial<{ agentGroupId: string; messageId: string }> = {}) {
  return { agentGroupId: 'grp-a', messageId: `msg-${++msgCounter}`, ...overrides };
}

// A Response body can only be read once, so every mock must mint a fresh one
// per call — a shared instance makes the second call look like a parse failure.
function okTranscription(text = 'transcribed text') {
  return new Response(JSON.stringify({ text, duration: 2.5 }), { status: 200 });
}

beforeEach(() => {
  configState.url = 'http://voicebox.local:8000';
  configState.model = 'whisper-ivrit-turbo';
  configState.language = 'he';
  configState.fallbackModel = '';
  configState.timeoutMs = 60000;
  dbState.row = undefined;
  __clearTranscriptCache();
  fetchMock = vi.fn().mockImplementation(async () => okTranscription());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('audio detection', () => {
  it('transcribes WhatsApp-shaped {type: "audio"}', async () => {
    const content = JSON.stringify({ text: '', attachments: [{ type: 'audio', data: B64 }] });
    const out = JSON.parse(await transcribeContent(content, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('transcribed text');
    expect(out.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('transcribes Telegram-shaped {type: "voice"}', async () => {
    const content = JSON.stringify({ attachments: [{ type: 'voice', data: B64 }] });
    const out = JSON.parse(await transcribeContent(content, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('transcribed text');
  });

  it('transcribes on an audio/* mimeType with no type field', async () => {
    const content = JSON.stringify({ attachments: [{ mimeType: 'audio/ogg', data: B64 }] });
    const out = JSON.parse(await transcribeContent(content, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('transcribed text');
  });

  it('is case-insensitive on type and mimeType', async () => {
    const content = JSON.stringify({
      attachments: [
        { type: 'VOICE', data: B64 },
        { mimeType: 'AUDIO/MPEG', data: B64 },
      ],
    });
    const out = JSON.parse(await transcribeContent(content, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attachments[0].transcript).toBe('transcribed text');
    expect(out.attachments[1].transcript).toBe('transcribed text');
  });

  it('sends the model in bare form and the configured language', async () => {
    await transcribeContent(JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] }), ctx());

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('ivrit-turbo');
    expect(form.get('language')).toBe('he');
  });

  it('omits transcriptModel when the server default is used', async () => {
    configState.model = '';
    const out = JSON.parse(
      await transcribeContent(JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] }), ctx()),
    );

    expect(out.attachments[0].transcript).toBe('transcribed text');
    expect(out.attachments[0].transcriptModel).toBeUndefined();
  });
});

describe('non-audio and malformed input is left alone', () => {
  it('leaves image and pdf attachments untouched with zero fetches', async () => {
    const content = JSON.stringify({
      text: 'look',
      attachments: [
        { type: 'image', mimeType: 'image/jpeg', data: B64 },
        { type: 'document', mimeType: 'application/pdf', data: B64 },
      ],
    });

    const out = await transcribeContent(content, ctx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe(content);
    const parsed = JSON.parse(out);
    expect(parsed.attachments[0].transcript).toBeUndefined();
    expect(parsed.attachments[1].transcript).toBeUndefined();
  });

  it('returns non-JSON content unchanged', async () => {
    const content = 'just a plain string, not JSON';
    expect(await transcribeContent(content, ctx())).toBe(content);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns content unchanged when there is no attachments array', async () => {
    const content = JSON.stringify({ text: 'hi' });
    expect(await transcribeContent(content, ctx())).toBe(content);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips an audio attachment with no inline data (url-only) and never fetches it', async () => {
    const content = JSON.stringify({ attachments: [{ type: 'audio', url: 'https://evil.example/x.ogg' }] });

    const out = await transcribeContent(content, ctx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe(content);
  });

  it('returns content unchanged when VOICEBOX_URL is empty', async () => {
    configState.url = '';
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    expect(await transcribeContent(content, ctx())).toBe(content);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ordering invariant: att.data must survive for extractAttachmentFiles', () => {
  it('leaves att.data present and byte-identical after a successful transcription', async () => {
    const content = JSON.stringify({
      attachments: [{ type: 'audio', name: 'voice.ogg', mimeType: 'audio/ogg', data: B64 }],
    });

    const out = JSON.parse(await transcribeContent(content, ctx()));
    const att = out.attachments[0];

    expect(att.data).toBe(B64);
    expect(att.localPath).toBeUndefined();
    expect(att.name).toBe('voice.ogg');
    expect(att.mimeType).toBe('audio/ogg');
    expect(att.transcript).toBe('transcribed text');
  });
});

describe('failure isolation', () => {
  it('returns the original content string byte-for-byte when VoiceBox fails', async () => {
    fetchMock.mockResolvedValue(new Response('Invalid model size', { status: 400 }));
    const content = JSON.stringify({ text: 'hi', attachments: [{ type: 'audio', data: B64 }] });

    const out = await transcribeContent(content, ctx());

    expect(out).toBe(content);
    expect(JSON.parse(out).attachments[0].data).toBe(B64);
  });

  it('survives a network throw without rejecting', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    await expect(transcribeContent(content, ctx())).resolves.toBe(content);
  });

  it('keeps processing later attachments after one fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(okTranscription('second one'));

    const content = JSON.stringify({
      attachments: [
        { type: 'audio', data: B64 },
        { type: 'voice', data: B64 },
      ],
    });

    const out = JSON.parse(await transcribeContent(content, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attachments[0].transcript).toBeUndefined();
    expect(out.attachments[1].transcript).toBe('second one');
  });
});

describe('per-group opt-out', () => {
  it('makes zero fetch calls when audio_transcription is "off"', async () => {
    dbState.row = { agent_group_id: 'grp-a', audio_transcription: 'off' };
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    const out = await transcribeContent(content, ctx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe(content);
  });

  it('transcribes when the setting is explicitly "on"', async () => {
    dbState.row = { agent_group_id: 'grp-a', audio_transcription: 'on' };
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    expect(JSON.parse(await transcribeContent(content, ctx())).attachments[0].transcript).toBe('transcribed text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults ON when the config row omits audio_transcription entirely', async () => {
    // Pins the `!== 'off'` semantics: a row predating the column must still
    // transcribe. `=== 'on'` would silently disable every legacy group.
    dbState.row = { agent_group_id: 'grp-a' };
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    expect(JSON.parse(await transcribeContent(content, ctx())).attachments[0].transcript).toBe('transcribed text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults ON when there is no config row at all', async () => {
    dbState.row = undefined;
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    expect(JSON.parse(await transcribeContent(content, ctx())).attachments[0].transcript).toBe('transcribed text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks the opt-out BEFORE the cache, so an off group neither fetches nor reads a cached transcript', async () => {
    const shared = ctx({ messageId: 'fanout-off' });
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    // Group A (on) populates the cache.
    await transcribeContent(content, shared);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Group B (off) must not even see the cached transcript.
    dbState.row = { agent_group_id: 'grp-b', audio_transcription: 'off' };
    const out = await transcribeContent(content, { agentGroupId: 'grp-b', messageId: 'fanout-off' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toBe(content);
  });
});

describe('isOffLanguage', () => {
  // The unit that decides whether a second engine is worth the latency. It has
  // to answer "no" to everything it cannot prove.
  it('is true for a Latin-script answer under a non-Latin pin', () => {
    expect(isOffLanguage('Hello, can you book a meeting tomorrow?', 'he')).toBe(true);
    expect(isOffLanguage('Hello there', 'ru')).toBe(true);
  });

  it('is false when one character of the pinned script is present', () => {
    // A Hebrew note peppered with English is still a Hebrew note — re-running it
    // on the English engine would throw the Hebrew away.
    expect(isOffLanguage('שלח לי את ה deploy log', 'he')).toBe(false);
    expect(isOffLanguage('שלום', 'he')).toBe(false);
  });

  it('is false for a Latin-script pin, where the script proves nothing', () => {
    // German audio pinned to `fr` comes back in the same alphabet.
    expect(isOffLanguage('Guten Morgen, wie geht es dir', 'fr')).toBe(false);
    expect(isOffLanguage('שלום', 'en')).toBe(false);
  });

  it('is false with no pin at all', () => {
    expect(isOffLanguage('Hello there', '')).toBe(false);
  });

  it('is false when there are no letters to judge', () => {
    expect(isOffLanguage('  ...  123 ', 'he')).toBe(false);
  });

  it('handles the other non-Latin pins', () => {
    expect(isOffLanguage('Hello', 'ja')).toBe(true);
    expect(isOffLanguage('こんにちは', 'ja')).toBe(false);
    expect(isOffLanguage('你好', 'zh')).toBe(false);
    expect(isOffLanguage('안녕하세요', 'ko')).toBe(false);
    expect(isOffLanguage('Привет', 'ru')).toBe(false);
  });
});

describe('English fallback engine', () => {
  const audio = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

  function formOf(callIndex: number): FormData {
    return fetchMock.mock.calls[callIndex][1].body as FormData;
  }

  it('does nothing when no fallback model is configured', async () => {
    fetchMock.mockImplementation(async () => okTranscription('Hello, this is English'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('Hello, this is English');
    expect(out.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('re-runs on the English engine when the primary answers outside the pinned script', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock
      .mockResolvedValueOnce(okTranscription('Hello, can you book a meeting'))
      .mockResolvedValueOnce(okTranscription('Hello, can you book a meeting tomorrow at nine'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(formOf(0).get('model')).toBe('ivrit-turbo');
    expect(formOf(0).get('language')).toBe('he');
    // The fallback is English-only by definition, whatever the primary pin was.
    expect(formOf(1).get('model')).toBe('turbo');
    expect(formOf(1).get('language')).toBe('en');
    expect(out.attachments[0].transcript).toBe('Hello, can you book a meeting tomorrow at nine');
    expect(out.attachments[0].transcriptModel).toBe('turbo');
  });

  it('strips the whisper- prefix from the fallback model too', async () => {
    configState.fallbackModel = 'whisper-turbo';
    fetchMock.mockResolvedValueOnce(okTranscription('English words')).mockResolvedValueOnce(okTranscription('better'));

    await transcribeContent(audio, ctx());

    expect(formOf(1).get('model')).toBe('turbo');
  });

  it('leaves a genuine Hebrew transcript alone', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock.mockImplementation(async () => okTranscription('שלח לי את הדוח מחר בבוקר'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('שלח לי את הדוח מחר בבוקר');
    expect(out.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('falls back on an empty primary transcript', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock.mockResolvedValueOnce(okTranscription('   ')).mockResolvedValueOnce(okTranscription('rescued'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attachments[0].transcript).toBe('rescued');
  });

  it('falls back when the primary engine errors', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock
      .mockResolvedValueOnce(new Response('Invalid model size', { status: 400 }))
      .mockResolvedValueOnce(okTranscription('rescued by the fallback'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attachments[0].transcript).toBe('rescued by the fallback');
    expect(out.attachments[0].transcriptModel).toBe('turbo');
  });

  it('does NOT fall back after a timeout, which already spent the whole budget', async () => {
    configState.fallbackModel = 'turbo';
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    const out = await transcribeContent(audio, ctx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toBe(audio);
  });

  it('keeps the primary answer when the fallback engine also fails', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock
      .mockResolvedValueOnce(okTranscription('Hello in the wrong script'))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attachments[0].transcript).toBe('Hello in the wrong script');
    expect(out.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('keeps the primary answer when the fallback returns nothing', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock.mockResolvedValueOnce(okTranscription('Hello there')).mockResolvedValueOnce(okTranscription(''));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(out.attachments[0].transcript).toBe('Hello there');
    expect(out.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('delivers untranscribed when both engines fail', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));

    expect(await transcribeContent(audio, ctx())).toBe(audio);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the fallback result, so a fanout does not re-run both engines', async () => {
    configState.fallbackModel = 'turbo';
    fetchMock
      .mockResolvedValueOnce(okTranscription('English'))
      .mockResolvedValueOnce(okTranscription('English, better'));

    const a = JSON.parse(await transcribeContent(audio, { agentGroupId: 'grp-a', messageId: 'fb-fan' }));
    const b = JSON.parse(await transcribeContent(audio, { agentGroupId: 'grp-b', messageId: 'fb-fan' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(b.attachments[0].transcript).toBe(a.attachments[0].transcript);
    expect(b.attachments[0].transcriptModel).toBe('turbo');
  });

  it('never falls back on language grounds when the pin is Latin-script', async () => {
    configState.language = 'en';
    configState.fallbackModel = 'turbo';
    fetchMock.mockImplementation(async () => okTranscription('Guten Morgen'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('Guten Morgen');
  });

  it('never falls back on language grounds when nothing is pinned', async () => {
    configState.language = '';
    configState.fallbackModel = 'turbo';
    fetchMock.mockImplementation(async () => okTranscription('Hello there'));

    const out = JSON.parse(await transcribeContent(audio, ctx()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.attachments[0].transcript).toBe('Hello there');
  });
});

describe('memoization across agent-group fanout', () => {
  it('transcribes once for three groups sharing a messageId', async () => {
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    const a = JSON.parse(await transcribeContent(content, { agentGroupId: 'grp-a', messageId: 'fan-1' }));
    const b = JSON.parse(await transcribeContent(content, { agentGroupId: 'grp-b', messageId: 'fan-1' }));
    const c = JSON.parse(await transcribeContent(content, { agentGroupId: 'grp-c', messageId: 'fan-1' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.attachments[0].transcript).toBe('transcribed text');
    expect(b.attachments[0].transcript).toBe('transcribed text');
    expect(c.attachments[0].transcript).toBe('transcribed text');
    expect(b.attachments[0].transcriptModel).toBe('ivrit-turbo');
  });

  it('does not share cache entries across different messageIds', async () => {
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    await transcribeContent(content, { agentGroupId: 'grp-a', messageId: 'm-1' });
    await transcribeContent(content, { agentGroupId: 'grp-a', messageId: 'm-2' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys per attachment index, so a two-audio message costs two calls once', async () => {
    fetchMock.mockResolvedValueOnce(okTranscription('one')).mockResolvedValueOnce(okTranscription('two'));
    const content = JSON.stringify({
      attachments: [
        { type: 'audio', data: B64 },
        { type: 'voice', data: B64 },
      ],
    });

    const first = JSON.parse(await transcribeContent(content, { agentGroupId: 'grp-a', messageId: 'multi' }));
    const second = JSON.parse(await transcribeContent(content, { agentGroupId: 'grp-b', messageId: 'multi' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.attachments.map((a: { transcript: string }) => a.transcript)).toEqual(['one', 'two']);
    expect(second.attachments.map((a: { transcript: string }) => a.transcript)).toEqual(['one', 'two']);
  });

  it('caches a failure so a fanout does not hammer a failing server', async () => {
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    const content = JSON.stringify({ attachments: [{ type: 'audio', data: B64 }] });

    await transcribeContent(content, { agentGroupId: 'grp-a', messageId: 'fail-fan' });
    await transcribeContent(content, { agentGroupId: 'grp-b', messageId: 'fail-fan' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
