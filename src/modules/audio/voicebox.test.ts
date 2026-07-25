/**
 * Tests for the VoiceBox HTTP client.
 *
 * The headline case is the `whisper-` prefix asymmetry, which was verified
 * against a live server: /models/* want the full name, /transcribe rejects it
 * with a 400. Everything else here is shape/plumbing coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadModel, listSttModels, toTranscribeModel, transcribe } from './voicebox.js';

const BASE = 'http://voicebox.local:8000';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toTranscribeModel — /transcribe rejects the `whisper-` prefix (regression guard)', () => {
  it('strips the `whisper-` prefix that the live server 400s on', () => {
    // Verified live: model=whisper-ivrit-turbo -> 400
    //   "Invalid model size 'whisper-ivrit-turbo'. Must be one of:
    //    base, small, medium, large, turbo, ivrit-turbo, ivrit-large"
    expect(toTranscribeModel('whisper-ivrit-turbo')).toBe('ivrit-turbo');
    expect(toTranscribeModel('whisper-turbo')).toBe('turbo');
    expect(toTranscribeModel('whisper-large')).toBe('large');
  });

  it('is idempotent — a bare size passes through unchanged', () => {
    expect(toTranscribeModel('ivrit-turbo')).toBe('ivrit-turbo');
    expect(toTranscribeModel('base')).toBe('base');
    expect(toTranscribeModel(toTranscribeModel('whisper-ivrit-turbo'))).toBe('ivrit-turbo');
  });

  it('handles empty input', () => {
    expect(toTranscribeModel('')).toBe('');
  });
});

describe('transcribe', () => {
  it('sends the model in BARE form in the multipart body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'shalom', duration: 1.5 }));

    await transcribe(BASE, Buffer.from('audiobytes'), 'voice.ogg', {
      model: 'whisper-ivrit-turbo',
      language: 'he',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/transcribe`);
    expect(init.method).toBe('POST');

    const form = init.body as FormData;
    expect(form.get('model')).toBe('ivrit-turbo');
    expect(form.get('model')).not.toBe('whisper-ivrit-turbo');
    expect(form.get('language')).toBe('he');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('omits model/language when empty so the server default applies', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hi', duration: 0.5 }));

    await transcribe(BASE, Buffer.from('x'), 'a.mp3', { model: '', language: '' });

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.has('model')).toBe(false);
    expect(form.has('language')).toBe(false);
  });

  it('parses {text, duration}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hello world', duration: 3.25 }));

    const out = await transcribe(BASE, Buffer.from('x'), 'a.ogg', {});
    expect(out).toEqual({ text: 'hello world', duration: 3.25 });
  });

  it('tolerates a response missing fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(await transcribe(BASE, Buffer.from('x'), 'a.ogg', {})).toEqual({ text: '', duration: 0 });
  });

  it('throws with status AND body on non-2xx (body carries the useful detail)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail:
            "Invalid model size 'whisper-ivrit-turbo'. Must be one of: base, small, medium, large, turbo, ivrit-turbo, ivrit-large",
        }),
        { status: 400 },
      ),
    );

    await expect(transcribe(BASE, Buffer.from('x'), 'a.ogg', {})).rejects.toThrow(/400/);
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(transcribe(BASE, Buffer.from('x'), 'a.ogg', {})).rejects.toThrow(/500.*boom/s);
  });

  it('trims a trailing slash off the base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: '', duration: 0 }));
    await transcribe(`${BASE}/`, Buffer.from('x'), 'a.ogg', {});
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/transcribe`);
  });
});

describe('downloadModel', () => {
  it('sends the FULL whisper-prefixed name in the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await downloadModel(BASE, 'whisper-turbo');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/models/download`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model_name: 'whisper-turbo' });
  });

  it('normalizes a bare size UP to the whisper- prefixed name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await downloadModel(BASE, 'ivrit-turbo');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model_name: 'whisper-ivrit-turbo' });
  });

  it('throws with status and body on failure', async () => {
    fetchMock.mockResolvedValue(new Response('no such model', { status: 404 }));
    await expect(downloadModel(BASE, 'whisper-nope')).rejects.toThrow(/404.*no such model/s);
  });
});

describe('listSttModels', () => {
  const FIXTURE = {
    models: [
      {
        model_name: 'whisper-turbo',
        display_name: 'Whisper Turbo',
        hf_repo_id: 'openai/whisper-large-v3-turbo',
        downloaded: true,
        downloading: false,
        size_mb: 1600,
        loaded: true,
      },
      {
        model_name: 'whisper-ivrit-turbo',
        display_name: 'ivrit.ai Turbo',
        hf_repo_id: 'ivrit-ai/whisper-large-v3-turbo',
        downloaded: false,
        downloading: true,
        size_mb: 1600,
        loaded: false,
      },
      { model_name: 'kokoro', display_name: 'Kokoro TTS', downloaded: true, downloading: false, loaded: false },
      {
        model_name: 'chatterbox-tts',
        display_name: 'Chatterbox',
        downloaded: false,
        downloading: false,
        size_mb: 900,
        loaded: false,
      },
      {
        model_name: 'qwen3-0.6b',
        display_name: 'Qwen3 0.6B',
        downloaded: true,
        downloading: false,
        size_mb: 600,
        loaded: false,
      },
    ],
  };

  it('keeps only whisper-* models, dropping TTS/LLM entries', async () => {
    fetchMock.mockResolvedValue(jsonResponse(FIXTURE));

    const models = await listSttModels(BASE);

    expect(models.map((m) => m.modelName)).toEqual(['whisper-turbo', 'whisper-ivrit-turbo']);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/models/status`);
  });

  it('maps snake_case fields, defaulting a missing size to null', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          { model_name: 'whisper-base', display_name: 'Base', downloaded: true, downloading: false, loaded: false },
        ],
      }),
    );

    expect(await listSttModels(BASE)).toEqual([
      {
        modelName: 'whisper-base',
        displayName: 'Base',
        downloaded: true,
        downloading: false,
        sizeMb: null,
        loaded: false,
      },
    ]);
  });

  it('returns [] when the payload has no models array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(await listSttModels(BASE)).toEqual([]);
  });

  it('throws with status and body on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('gateway down', { status: 502 }));
    await expect(listSttModels(BASE)).rejects.toThrow(/502.*gateway down/s);
  });
});
