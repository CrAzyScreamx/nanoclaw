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
 */
import { VOICEBOX_URL, VOICEBOX_STT_MODEL, VOICEBOX_STT_LANGUAGE, VOICEBOX_TIMEOUT_MS } from '../../config.js';
import { extForMime } from '../../attachment-naming.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { log } from '../../log.js';

import { toTranscribeModel, transcribe } from './voicebox.js';

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
      const result = await transcribe(VOICEBOX_URL, bytes, audioFilename(att, i), {
        model: configuredModel,
        language: VOICEBOX_STT_LANGUAGE,
        timeoutMs: VOICEBOX_TIMEOUT_MS,
      });
      const text = result.text ?? '';
      cachePut(key, { ok: true, text, model: configuredModel });
      att.transcript = text;
      // Omitted when the server default was used — we cannot know its name.
      if (configuredModel) att.transcriptModel = configuredModel;
      changed = true;
      log.info('Transcribed inbound audio', {
        messageId: ctx.messageId,
        index: i,
        audioSeconds: result.duration,
        chars: text.length,
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
