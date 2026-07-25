/**
 * VoiceBox HTTP client — speech-to-text against a self-hosted VoiceBox server.
 *
 * Zero dependencies: global `fetch` / `FormData` / `Blob` / `AbortSignal.timeout`
 * (Node 20+). Nothing here touches the DB or the router; see
 * `transcribe-inbound.ts` for the ingest-time wiring.
 *
 * ## The `whisper-` prefix trap (verified against a live server)
 *
 * `/models/status` and `/models/download` speak the FULL model name
 * (`whisper-ivrit-turbo`). `/transcribe` speaks the BARE size (`ivrit-turbo`)
 * and rejects the prefixed form outright:
 *
 *   model=whisper-ivrit-turbo -> 400 "Invalid model size 'whisper-ivrit-turbo'.
 *                                     Must be one of: base, small, medium,
 *                                     large, turbo, ivrit-turbo, ivrit-large"
 *   model=ivrit-turbo         -> 200
 *
 * `toTranscribeModel` is the single chokepoint for that normalization, and
 * `downloadModel` normalizes back UP so callers can pass either form anywhere.
 *
 * The server is CPU-only in the reference deployment, so transcription of a
 * long clip can take minutes — every call is timeout-bounded.
 */

/** One speech-to-text model as reported by `GET /models/status`. */
export interface SttModel {
  /** Full name, `whisper-` prefixed (e.g. `whisper-ivrit-turbo`). */
  modelName: string;
  displayName: string;
  downloaded: boolean;
  downloading: boolean;
  sizeMb: number | null;
  loaded: boolean;
}

/** `/models/status` returns TTS and STT models mixed; STT is exactly this prefix. */
const STT_PREFIX = 'whisper-';

const DEFAULT_TIMEOUT_MS = 60000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function assertOk(res: Response, body: string, what: string): void {
  if (res.ok) return;
  // The body carries the useful detail (e.g. "Invalid model size '...'"), so it
  // must survive into the thrown message — a bare status is undebuggable.
  throw new Error(`VoiceBox ${what} failed: HTTP ${res.status} ${body}`);
}

/**
 * Strip the `whisper-` prefix for `/transcribe`, which only accepts the bare
 * size. Idempotent: a bare name passes through unchanged.
 */
export function toTranscribeModel(name: string): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  return trimmed.startsWith(STT_PREFIX) ? trimmed.slice(STT_PREFIX.length) : trimmed;
}

/** Normalize UP to the full `whisper-` prefixed name used by /models/*. */
function toFullModelName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith(STT_PREFIX) ? trimmed : `${STT_PREFIX}${trimmed}`;
}

/** List the speech-to-text models the server knows about (TTS models filtered out). */
export async function listSttModels(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SttModel[]> {
  const res = await fetch(joinUrl(baseUrl, '/models/status'), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readBody(res);
  assertOk(res, body, 'models/status');

  let parsed: { models?: unknown };
  try {
    parsed = JSON.parse(body) as { models?: unknown };
  } catch (err) {
    throw new Error(`VoiceBox models/status returned non-JSON: ${body.slice(0, 200)}`, { cause: err });
  }

  const models = Array.isArray(parsed.models) ? (parsed.models as Array<Record<string, unknown>>) : [];
  return models
    .filter((m) => typeof m.model_name === 'string' && m.model_name.startsWith(STT_PREFIX))
    .map((m) => ({
      modelName: m.model_name as string,
      displayName: typeof m.display_name === 'string' ? m.display_name : (m.model_name as string),
      downloaded: m.downloaded === true,
      downloading: m.downloading === true,
      sizeMb: typeof m.size_mb === 'number' ? m.size_mb : null,
      loaded: m.loaded === true,
    }));
}

/**
 * Ask the server to download a model. Accepts either the full or the bare name;
 * the wire body always carries the FULL `whisper-` prefixed name.
 */
export async function downloadModel(baseUrl: string, modelName: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const res = await fetch(joinUrl(baseUrl, '/models/download'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model_name: toFullModelName(modelName) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readBody(res);
  assertOk(res, body, 'models/download');
}

export interface TranscribeResult {
  text: string;
  /** Length of the AUDIO in seconds — not the processing time. */
  duration: number;
}

/**
 * Transcribe raw audio bytes. `model` is normalized to the bare size before it
 * goes on the wire (see the prefix-trap note at the top of this file).
 */
export async function transcribe(
  baseUrl: string,
  bytes: Buffer,
  filename: string,
  opts: { model?: string; language?: string; timeoutMs?: number } = {},
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), filename || 'audio');

  const model = toTranscribeModel(opts.model ?? '');
  if (model) form.append('model', model);
  const language = (opts.language ?? '').trim();
  if (language) form.append('language', language);

  const res = await fetch(joinUrl(baseUrl, '/transcribe'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const body = await readBody(res);
  assertOk(res, body, 'transcribe');

  let parsed: { text?: unknown; duration?: unknown };
  try {
    parsed = JSON.parse(body) as { text?: unknown; duration?: unknown };
  } catch (err) {
    throw new Error(`VoiceBox transcribe returned non-JSON: ${body.slice(0, 200)}`, { cause: err });
  }

  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    duration: typeof parsed.duration === 'number' ? parsed.duration : 0,
  };
}
