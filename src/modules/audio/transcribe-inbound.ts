/**
 * Ingest-time transcription of inbound audio attachments.
 *
 * Runs in the router, BEFORE the message content is written into the session's
 * `inbound.db`, so the transcript becomes part of the persisted conversation
 * history rather than something the agent has to re-derive on every turn.
 *
 * ## Ordering invariant (load-bearing)
 *
 * This runs BEFORE `extractAttachmentFiles` (src/session-manager.ts) — the step
 * that stages base64 bytes to disk and swaps `att.data` for `att.localPath`.
 * So here we see `att.data` and never `att.localPath`, and we must leave
 * `att.data` byte-for-byte intact: dropping or rewriting it would destroy the
 * audio file before it is ever written to the session inbox. We only ADD
 * fields (`transcript`, `transcriptModel`).
 *
 * ## Failure policy
 *
 * Never throws. A message always routes. Any per-attachment failure is caught,
 * logged at warn, and the remaining attachments still process. If nothing was
 * transcribed the ORIGINAL content string is returned unchanged (not a
 * re-stringified round trip), so non-audio traffic is bit-identical to the
 * pre-feature behavior.
 *
 * ## Memoization
 *
 * One inbound platform message can fan out to N agent groups, each calling this
 * with the same `messageId`. The bounded FIFO cache below makes that exactly one
 * `/transcribe` call per attachment. The per-group `audio_transcription: 'off'`
 * check happens BEFORE the cache lookup, so an opted-out group neither reads nor
 * populates the cache — and makes zero network calls.
 *
 * ## The English fallback engine (optional, `VOICEBOX_STT_FALLBACK_MODEL`)
 *
 * A primary engine pinned to one language handles that language best and
 * everything else worse. When a fallback engine is configured, a clip that the
 * primary plainly did not handle is re-run once on that engine pinned to `en`.
 *
 * What "plainly did not handle" can and cannot mean was measured against a live
 * server, and the asymmetry is the whole design (English speech, `language=he`):
 *
 *   ivrit-turbo + he -> "Hello, can you please book a meeting..."   Latin script
 *   base        + he -> "הלו, פליזו בוקר מידים את זה..."             Hebrew script
 *   base        + -- -> "Hello, can you please book a meeting..."   Latin script
 *
 * The first row is detectable: the pin says Hebrew, not one Hebrew character
 * came back, so the speaker was not speaking Hebrew. The second is NOT — a wrong
 * pin makes Whisper transliterate confidently INTO the pinned script, and
 * nothing in a `{text, duration}` response separates that from a real
 * transcript. So this seam catches off-language notes only when the primary
 * answers outside the pinned script; garbage inside it is unreachable from here
 * and is a `VOICEBOX_STT_LANGUAGE` problem, not a fallback problem.
 */
import {
  VOICEBOX_URL,
  VOICEBOX_STT_MODEL,
  VOICEBOX_STT_LANGUAGE,
  VOICEBOX_STT_FALLBACK_MODEL,
  VOICEBOX_TIMEOUT_MS,
} from '../../config.js';
import { extForMime } from '../../attachment-naming.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { log } from '../../log.js';

import { toTranscribeModel, transcribe, type TranscribeResult } from './voicebox.js';

/** Attachment `type` values that mean "this is speech" across adapters. */
const AUDIO_TYPES = new Set(['audio', 'voice']);

/**
 * Bounded FIFO memo, keyed by `<messageId>#<attachmentIndex>`. Mirrors the
 * `sentMessageCache` eviction idiom in src/channels/whatsapp.ts: insertion order
 * is Map iteration order, so the first key is the oldest.
 *
 * Failures are cached too — a CPU-only VoiceBox that just timed out should not
 * be hit N more times for the same message during the same fanout.
 */
const TRANSCRIPT_CACHE_MAX = 200;
type CacheEntry = { ok: true; text: string; model: string } | { ok: false };
const transcriptCache = new Map<string, CacheEntry>();

function cachePut(key: string, entry: CacheEntry): void {
  transcriptCache.set(key, entry);
  if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value!;
    transcriptCache.delete(oldest);
  }
}

/** The fallback engine is English-only by definition — that is what it is for. */
const FALLBACK_LANGUAGE = 'en';

/**
 * Languages whose script is distinctive enough that its ABSENCE from a
 * transcript proves the speaker was not speaking the pinned language.
 *
 * Latin-script pins (`en`, `de`, `fr`, `es`, `it`, `pt`) are deliberately
 * absent: German audio pinned to French comes back in the same alphabet, so
 * there is no signal here and we must not invent one.
 */
const PINNED_SCRIPTS: Record<string, RegExp> = {
  he: /[\u0590-\u05FF]/,
  ar: /[\u0600-\u06FF]/,
  ru: /[\u0400-\u04FF]/,
  el: /[\u0370-\u03FF]/,
  hi: /[\u0900-\u097F]/,
  zh: /[\u4E00-\u9FFF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
};

const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/;

/**
 * True when `text` is confidently NOT in `pinnedLanguage`, and therefore worth
 * a second pass on the English engine.
 *
 * Conservative on purpose — three ways to answer "no":
 *   - no pin, or a pin whose script tells us nothing (Latin-script languages);
 *   - one character of the expected script anywhere (a mostly-English Hebrew
 *     note is still a Hebrew note, and re-running it would lose the Hebrew);
 *   - no Latin letters either (digits and punctuation are not evidence).
 */
export function isOffLanguage(text: string, pinnedLanguage: string): boolean {
  const script = PINNED_SCRIPTS[(pinnedLanguage ?? '').trim().toLowerCase()];
  if (!script) return false;
  if (script.test(text)) return false;
  return LATIN_LETTER.test(text);
}

/** Why the English engine ran. Absent when the primary's answer was kept. */
type FallbackReason = 'primary-failed' | 'empty-transcript' | 'off-language';

/**
 * A timeout already spent the whole per-clip budget; a second engine would
 * double the delay on exactly the clips that are already slowest. Only cheap
 * failures (HTTP 4xx/5xx, connection refused) fall through to the fallback.
 */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function callVoicebox(bytes: Buffer, filename: string, model: string, language: string): Promise<TranscribeResult> {
  return transcribe(VOICEBOX_URL, bytes, filename, { model, language, timeoutMs: VOICEBOX_TIMEOUT_MS });
}

/**
 * One clip, at most two engines. Throws only when there is no usable transcript
 * at all — the caller treats that as "deliver the audio untranscribed".
 */
async function transcribeWithFallback(
  bytes: Buffer,
  filename: string,
  primaryModel: string,
  fallbackModel: string,
): Promise<{ result: TranscribeResult; model: string; fallback: FallbackReason | null }> {
  let primary: TranscribeResult | undefined;
  let reason: FallbackReason | null = null;

  try {
    primary = await callVoicebox(bytes, filename, primaryModel, VOICEBOX_STT_LANGUAGE);
  } catch (err) {
    if (!fallbackModel || isTimeout(err)) throw err;
    reason = 'primary-failed';
  }

  if (primary) {
    if (!fallbackModel) return { result: primary, model: primaryModel, fallback: null };
    const text = primary.text.trim();
    if (!text) reason = 'empty-transcript';
    else if (isOffLanguage(text, VOICEBOX_STT_LANGUAGE)) reason = 'off-language';
    else return { result: primary, model: primaryModel, fallback: null };
  }

  try {
    const second = await callVoicebox(bytes, filename, fallbackModel, FALLBACK_LANGUAGE);
    // An empty answer from the fallback is not an improvement on a primary that
    // at least said something — keep whichever actually has words.
    if (!second.text.trim() && primary?.text.trim()) {
      return { result: primary, model: primaryModel, fallback: null };
    }
    return { result: second, model: fallbackModel, fallback: reason };
  } catch (err) {
    // The primary's own answer, however off-language, beats nothing at all.
    if (primary) return { result: primary, model: primaryModel, fallback: null };
    throw err;
  }
}

function isAudioAttachment(att: Record<string, unknown>): boolean {
  if (typeof att.type === 'string' && AUDIO_TYPES.has(att.type.toLowerCase())) return true;
  return typeof att.mimeType === 'string' && att.mimeType.toLowerCase().startsWith('audio/');
}

/** Filename for the multipart part. Only cosmetic to the server, but the
 *  extension is the one hint it gets about the container format. */
function audioFilename(att: Record<string, unknown>, index: number): string {
  if (typeof att.name === 'string' && att.name) return att.name;
  const type = typeof att.type === 'string' ? att.type.toLowerCase() : '';
  // extForMime is the repo's canonical MIME→ext map; fall back to the coarse
  // media-class the chat-sdk bridge sets when no MIME is present.
  const ext = extForMime(att.mimeType) || (type === 'voice' ? 'ogg' : 'mp3');
  return `audio-${index}.${ext}`;
}

/**
 * Transcribe every inline-base64 audio attachment in a JSON message payload.
 * Returns the (possibly augmented) content string. Never throws.
 */
export async function transcribeContent(
  content: string,
  ctx: { agentGroupId: string; messageId: string },
): Promise<string> {
  if (!VOICEBOX_URL) return content;

  // Per-group opt-out, checked before anything else touches the network.
  try {
    // Default-ON: compared against 'off', never 'on', so a missing row, a row
    // predating the column, and an explicit 'on' all mean enabled. The column
    // itself is NOT NULL DEFAULT 'on'; the field is optional on the type only
    // because one in-memory literal in backfill-container-configs.ts omits it.
    if (getContainerConfig(ctx.agentGroupId)?.audio_transcription === 'off') return content;
  } catch (err) {
    log.warn('Audio transcription: container config lookup failed, proceeding', {
      agentGroupId: ctx.agentGroupId,
      err,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object') return content;

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return content;

  const configuredModel = toTranscribeModel(VOICEBOX_STT_MODEL || '');
  const fallbackModel = toTranscribeModel(VOICEBOX_STT_FALLBACK_MODEL || '');
  let changed = false;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || typeof att !== 'object') continue;
    if (!isAudioAttachment(att)) continue;

    if (typeof att.data !== 'string' || !att.data) {
      // URL-only attachment. We deliberately do not fetch arbitrary URLs.
      log.warn('Audio attachment has no inline data, skipping transcription', {
        messageId: ctx.messageId,
        index: i,
      });
      continue;
    }

    const key = `${ctx.messageId}#${i}`;
    const cached = transcriptCache.get(key);
    if (cached) {
      if (cached.ok) {
        att.transcript = cached.text;
        if (cached.model) att.transcriptModel = cached.model;
        changed = true;
      }
      continue;
    }

    try {
      // NOTE: att.data is only READ here. It must survive untouched — the
      // session-manager stages it to disk after us.
      const bytes = Buffer.from(att.data, 'base64');
      const { result, model, fallback } = await transcribeWithFallback(
        bytes,
        audioFilename(att, i),
        configuredModel,
        fallbackModel,
      );
      const text = result.text ?? '';
      cachePut(key, { ok: true, text, model });
      att.transcript = text;
      // Omitted when the server default was used — we cannot know its name.
      if (model) att.transcriptModel = model;
      changed = true;
      log.info('Transcribed inbound audio', {
        messageId: ctx.messageId,
        index: i,
        audioSeconds: result.duration,
        chars: text.length,
        model: model || '(server default)',
        // Present only when the English engine produced this text.
        ...(fallback ? { fallbackReason: fallback } : {}),
      });
    } catch (err) {
      cachePut(key, { ok: false });
      log.warn('Audio transcription failed, delivering message untranscribed', {
        messageId: ctx.messageId,
        index: i,
        err,
      });
    }
  }

  // Byte-for-byte passthrough when nothing was added.
  return changed ? JSON.stringify(parsed) : content;
}

/** Test-only: drop memoized transcripts so cases don't leak into each other. */
export function __clearTranscriptCache(): void {
  transcriptCache.clear();
}
