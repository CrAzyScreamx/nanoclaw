/**
 * call-mapping.ts — ElevenLabs conversation shapes → the neutral call model.
 *
 * Pure functions, no instance state, no I/O: a wire row goes in, a CallSummary
 * or CallReport comes out. It lives beside `provider.ts` (like `persona-body.ts`
 * does for personas) so the adapter can grow the windowing logic finding #3
 * needed without pushing the file over the 500-line rule.
 *
 * It imports the domain model and the wire types and NOTHING else — no state,
 * no carriers, no http — which is what keeps it a mapper rather than a second
 * adapter.
 */

import type {
  CallReport, CallStatus, CallSummary, CarrierKind, TranscriptTurn,
} from '../../lib/provider.ts';
import type {
  ElConversationDetail, ElConversationSummary, ElDataCollectionResult,
} from './types.ts';

export const CARRIER_KINDS: CarrierKind[] = ['twilio', 'exotel', 'sip_trunk'];

/**
 * Anything unrecognised becomes 'unknown' rather than being guessed at. The
 * sweep treats 'unknown' as NOT finished, so a status this map has never heard
 * of holds a watermark back instead of dropping the call.
 */
export function mapStatus(status: string | undefined | null): CallStatus {
  switch (status) {
    case 'initiated':
    case 'in-progress':
    case 'processing':
    case 'done':
    case 'failed':
      return status;
    default:
      return 'unknown';
  }
}

export function mapCarrier(kind: string | undefined | null): CarrierKind | null {
  return CARRIER_KINDS.includes(kind as CarrierKind) ? (kind as CarrierKind) : null;
}

export function mapCollected(results: Record<string, ElDataCollectionResult> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(results ?? {})) {
    out[key] = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  }
  return out;
}

export function toSummary(raw: ElConversationSummary): CallSummary {
  // The list response is documented to carry data_collection_results even
  // though it is not in the summary shape; read it defensively rather than
  // spending a detail fetch per call on a sweep.
  const widened = raw as ElConversationSummary & { data_collection_results?: Record<string, ElDataCollectionResult> };
  return {
    id: raw.conversation_id,
    direction: raw.direction ?? null,
    status: mapStatus(raw.status),
    startedAt: typeof raw.start_time_unix_secs === 'number' ? raw.start_time_unix_secs : null,
    durationSec: typeof raw.call_duration_secs === 'number' ? raw.call_duration_secs : null,
    fromNumber: null,
    toNumber: null,
    personaId: raw.agent_id ?? null,
    personaName: raw.agent_name ?? null,
    title: raw.call_summary_title ?? null,
    summary: raw.transcript_summary ?? null,
    successful: raw.call_successful ?? 'unknown',
    collected: mapCollected(widened.data_collection_results),
  };
}

export function toReport(raw: ElConversationDetail): CallReport {
  const phone = raw.metadata?.phone_call;
  const transcript: TranscriptTurn[] = (raw.transcript ?? [])
    .filter((turn) => typeof turn?.message === 'string' && turn.message.length > 0)
    .map((turn) => ({
      role: turn.role === 'user' ? 'user' : 'agent',
      text: turn.message as string,
      timeSec: typeof turn.time_in_call_secs === 'number' ? turn.time_in_call_secs : null,
    }));

  const base = toSummary(raw);
  const direction = raw.direction ?? phone?.direction ?? null;
  return {
    ...base,
    direction,
    startedAt: base.startedAt ?? raw.metadata?.start_time_unix_secs ?? null,
    durationSec: base.durationSec ?? raw.metadata?.call_duration_secs ?? null,
    fromNumber: direction === 'inbound' ? (phone?.external_number ?? null) : (phone?.agent_number ?? null),
    toNumber: direction === 'inbound' ? (phone?.agent_number ?? null) : (phone?.external_number ?? null),
    title: raw.call_summary_title ?? null,
    summary: raw.analysis?.transcript_summary ?? raw.transcript_summary ?? null,
    successful: raw.analysis?.call_successful ?? raw.call_successful ?? 'unknown',
    collected: raw.analysis?.data_collection_results
      ? mapCollected(raw.analysis.data_collection_results)
      : base.collected,
    transcript,
    callSid: phone?.call_sid ?? null,
    carrier: mapCarrier(phone?.type),
  };
}
