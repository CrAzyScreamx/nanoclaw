/**
 * carriers/index.ts — carrier kind → hang-up adapter.
 *
 * The carrier is orthogonal to the speech provider: an ElevenLabs line and a
 * later OpenAI-over-SIP line would hang up through the same adapters. Every path
 * out of here returns a `Carrier`; when hang-up is not possible the returned
 * `Carrier` carries a NAMED reason in `unavailable` and its `endCall` throws that
 * same reason. It is never a no-op and never a silent success.
 *
 * TWILIO IS THE ONLY HANG-UP ADAPTER THIS TEMPLATE SHIPS. Exotel and SIP trunk
 * are still detected, still dialable, and still reported per line — the carrier
 * kind is real data read from ElevenLabs, and outbound calling picks its route
 * from it. What they do not have is a hang-up route, because neither was ever
 * confirmed against a live account. Shipping an unverified hang-up is worse than
 * shipping none: the failure mode is a call that keeps running while the agent
 * reports success. They are refused by name here instead, and can be added back
 * once someone has tested them for real.
 */

import {
  UnsupportedCapabilityError,
  type Carrier,
  type CarrierKind,
  type CarrierValue,
  type HangUpStrategy,
} from '../lib/provider.ts';
import type { VoiceLineConfig } from '../lib/state.ts';
import { createTwilioCarrier } from './twilio.ts';

/** The carrier kinds that have a hang-up adapter here. Detection covers more. */
export const HANGUP_CARRIERS: CarrierKind[] = ['twilio'];

export const CARRIER_UNKNOWN =
  "this line's carrier has not been detected yet; run " +
  '`bun /workspace/agent/plugins/voice-agent/tools/lines.ts list` first — it reads each line\'s ' +
  'carrier from ElevenLabs and records it in /workspace/agent/voice-line/config.json';

/** The always-available alternative, appended to every refusal below. */
const FALLBACK =
  'The `end_call` system tool on the persona ends calls on every carrier and every plan, and is ' +
  'the route to offer instead — see references/ending-a-call.md';

export const EXOTEL_NO_ADAPTER =
  'this line is carried on Exotel, and this template ships no Exotel hang-up adapter. The Legs ' +
  'API route it would need was never confirmed against a live Exotel account, so it was removed ' +
  'rather than shipped as something that might silently do nothing. Hang-up in flight is not ' +
  'available on this line. ' +
  FALLBACK;

export const SIP_NO_ADAPTER =
  'this line is carried on a SIP trunk, and this template ships no SIP hang-up adapter. There is ' +
  'no generic SIP hang-up to ship: ElevenLabs ends a SIP call by sending a BYE to the Contact ' +
  'address from the 200 OK, and nothing inside an agent container can originate SIP. The only ' +
  "route would be the trunk vendor's own REST API, which differs per vendor and may not address a " +
  'trunk call at all — Telnyx, for one, requires the call to live under a Call Control ' +
  'application, which a plain elastic trunk call is not. None of it was verified, so none of it ' +
  'ships. Hang-up in flight is not available on this line. ' +
  FALLBACK;

/**
 * A carrier that refuses by name. Used for every kind without an adapter, and
 * for a kind that was never detected. `kind` reports what the line actually is
 * (or the literal string "unknown"); `Carrier.kind` is a CarrierValue, so that
 * is expressible without a cast. Nothing switches on it, because `unavailable`
 * is non-null and `endCall` always throws.
 */
function refusing(kind: CarrierValue, reason: string): Carrier {
  return {
    kind,
    unavailable: reason,
    async endCall() {
      throw new UnsupportedCapabilityError(String(kind), 'end this call', reason);
    },
  };
}

export function carrierFor(kind: CarrierValue | null | undefined, cfg: VoiceLineConfig): Carrier {
  switch (kind) {
    case 'twilio':
      return createTwilioCarrier(cfg);
    case 'exotel':
      return refusing('exotel', EXOTEL_NO_ADAPTER);
    case 'sip_trunk':
      return refusing('sip_trunk', SIP_NO_ADAPTER);
    case null:
    case undefined:
      return refusing('unknown', CARRIER_UNKNOWN);
    default:
      return refusing(
        'unknown',
        `carrier "${String(kind)}" is not one of twilio / exotel / sip_trunk, so there is no ` +
          'hang-up adapter for it. ' +
          CARRIER_UNKNOWN,
      );
  }
}

/**
 * Carrier-derived hang-up strategies for this install: `['carrier']` when at
 * least one recorded line sits on a carrier whose adapter is fully configured,
 * otherwise `[]`.
 *
 * The `monitor` strategy is provider-specific and is unioned in by the provider
 * (see providers/elevenlabs/provider.ts), which keeps this module free of any
 * provider import.
 */
export function hangUpStrategies(cfg: VoiceLineConfig): HangUpStrategy[] {
  const lines = Object.values(cfg.lines ?? {});
  for (const line of lines) {
    if (carrierFor(line.carrier, cfg).unavailable === null) return ['carrier'];
  }
  return [];
}

/**
 * Per-carrier readiness, for setup flows that explain what is missing. All three
 * detectable kinds are listed, not just the one with an adapter: a user whose
 * line is on Exotel needs to be told that hang-up is unavailable and why, not
 * left to infer it from an absence.
 */
export function carrierReadiness(cfg: VoiceLineConfig): { kind: CarrierKind; reason: string | null }[] {
  const kinds: CarrierKind[] = ['twilio', 'exotel', 'sip_trunk'];
  return kinds.map((kind) => ({ kind, reason: carrierFor(kind, cfg).unavailable }));
}
