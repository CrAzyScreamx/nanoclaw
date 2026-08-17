// ============================================================================
// lib/provider.ts — the whole domain surface of the voice-agent template.
//
// This file imports NOTHING. It is the leaf of the dependency graph so that
// lib/http.ts can throw these error classes without creating a cycle, and so
// that a provider adapter can be written against it alone.
//
// Everything here is provider-neutral: no ElevenLabs wire vocabulary ever
// crosses this boundary. A Line carries `id`, never `phone_number_id`.
// ============================================================================

export type InboundSupport = 'managed' | 'self-hosted' | 'none';

/** Which live-call controls are actually usable on this install. */
export type HangUpStrategy = 'carrier' | 'monitor';

export interface ProviderCapabilities {
  inbound: InboundSupport;   // elevenlabs: 'managed'
  outbound: boolean;
  campaigns: boolean;
  personaManagement: boolean;
  transcripts: boolean;
  hangUp: HangUpStrategy[];  // empty = cannot end a call in flight
}

/** The phone network a line is carried on — orthogonal to the speech provider. */
export type CarrierKind = 'twilio' | 'exotel' | 'sip_trunk';

/**
 * A carrier value as it may actually arrive: one of the three routable kinds, or
 * whatever string the provider reported. The unknown case is kept visible in the
 * type rather than cast away, so nothing can switch on `carrier` and wrongly
 * assume exhaustiveness — `carrierFor` refuses an unrecognised value by name.
 */
export type CarrierValue = CarrierKind | (string & {});

/**
 * The result of a carrier's read-only credential probe.
 *
 * A probe exists so a wrong vault entry is found by a harmless GET rather than
 * by a 401 in the middle of a live call. `detail` carries what a pass does NOT
 * prove as well as what it does — a probe that reads is not a probe that writes.
 */
export interface CarrierCheck {
  ok: boolean;
  /** The request that was actually made, so the answer can be judged. */
  probe: string;
  detail: string;
}

export interface Carrier {
  readonly kind: CarrierValue;
  /** A reason string when this carrier cannot end calls; null when it can. */
  readonly unavailable: string | null;
  endCall(callSid: string): Promise<void>;
  /**
   * A read-only request that proves the vault credential reaches this carrier.
   * OPTIONAL: a carrier that has no safe read to make omits it, and callers say
   * "no probe exists here" rather than inventing reassurance.
   */
  check?(): Promise<CarrierCheck>;
}

// ---------------------------------------------------------------- domain types

export interface Line {
  id: string;
  number: string;
  label: string;
  /** May be a value outside CarrierKind; see CarrierValue. */
  carrier: CarrierValue;
  answeredBy: { id: string; name: string } | null;
}

export interface Persona {
  id: string;
  name: string;
  createdAt: number | null;   // unix seconds
}

export interface PersonaDetail extends Persona {
  prompt: string;
  firstMessage: string;
  language: string;
  voiceId: string | null;
  tools: string[];
  /** True when the `end_call` system tool is configured on this persona. */
  hasEndCallTool: boolean;
}

export interface PersonaInput {
  name: string;
  prompt?: string;
  firstMessage?: string;
  language?: string;
  voiceId?: string;
  /** Defaults to true — a persona without it runs until the callee hangs up. */
  endCallTool?: boolean;
}

export interface PlaceCallInput {
  lineId: string;
  personaId: string;
  toNumber: string;
  /**
   * The line's carrier as the caller knows it — a hint, never a default. The
   * provider re-maps it and refuses anything outside CarrierKind, because the
   * wrong outbound route fails obscurely.
   */
  carrier: CarrierValue;
  variables?: Record<string, string>;
}

export interface CallHandle {
  conversationId: string;
  /** Carrier-side id when the provider returned one (callSid / sip_call_id). */
  callSid: string | null;
  carrier: CarrierKind;
  accepted: boolean;
  message: string | null;
}

export type CallDirection = 'inbound' | 'outbound';

export type CallStatus =
  | 'initiated'
  | 'in-progress'
  | 'processing'
  | 'done'
  | 'failed'
  | 'unknown';

export const LIVE_STATUSES: readonly CallStatus[] = ['initiated', 'in-progress', 'processing'];

export const CONNECT_REFERENCE = 'skills/voice-line/references/connect-provider.md';

export interface CallFilter {
  direction?: CallDirection;
  personaId?: string;
  /** unix seconds; maps to call_start_after_unix */
  startedAfter?: number;
  status?: CallStatus;
  live?: boolean;
  limit?: number;
  cursor?: string;
  /**
   * How many rows the adapter may READ upstream before answering — deliberately
   * a different number from `limit`, which caps what comes back. Direction,
   * status and live are filtered after the fetch, so a `limit` of 30 on a busy
   * line needs a much larger scan to find 30 matches. Omitted, the adapter picks
   * an over-fetch of its own.
   */
  scan?: number;
  /**
   * Wall-clock ceiling for that upstream read. When it runs out the adapter
   * stops paging and answers `complete: false` with what it has, rather than
   * blowing a caller's own deadline (the sweep runs under a 30s runner cap).
   */
  scanBudgetMs?: number;
  /**
   * Return the OLDEST matches first, and apply `limit` after that ordering.
   * The sweep depends on this: it advances a watermark past what it reported,
   * so it must be given the oldest end of the window, never the newest.
   */
  oldestFirst?: boolean;
}

export interface CallSummary {
  id: string;
  direction: CallDirection | null;
  status: CallStatus;
  startedAt: number | null;       // unix seconds
  durationSec: number | null;
  fromNumber: string | null;
  toNumber: string | null;
  personaId: string | null;
  personaName: string | null;
  title: string | null;
  summary: string | null;
  successful: 'success' | 'failure' | 'unknown';
  collected: Record<string, unknown>;
}

/**
 * A page of calls plus whether the adapter is sure it saw the WHOLE window it
 * was asked for.
 *
 * `complete: false` means older rows matching the filter exist that were never
 * fetched — a page cap, a row cap or a time budget cut the read short. A caller
 * that advances a watermark past what it read (the sweep) MUST NOT advance on
 * an incomplete window, or the rows it never saw fall below the new watermark
 * and are lost for good.
 *
 * An adapter that cannot tell must answer `false`. A wrong `false` costs one
 * held watermark and a repeated fetch; a wrong `true` costs calls, silently.
 */
export interface CallWindow {
  calls: CallSummary[];
  complete: boolean;
}

export interface TranscriptTurn {
  role: 'agent' | 'user';
  text: string;
  timeSec: number | null;
}

export interface CallReport extends CallSummary {
  transcript: TranscriptTurn[];
  /** metadata.phone_call.call_sid — what every hang-up route needs. */
  callSid: string | null;
  carrier: CarrierKind | null;
}

export interface CampaignRecipient {
  number: string;
  variables?: Record<string, string>;
}

export interface CampaignInput {
  name: string;
  lineId: string;
  personaId: string;
  recipients: CampaignRecipient[];
  /** unix seconds; omitted/null = start now */
  scheduledAt?: number | null;
}

export interface CampaignHandle {
  id: string;
  name: string;
  status: string;
  total: number;
}

export interface CampaignStatus extends CampaignHandle {
  dispatched: number;
  completed: number;
  failed: number;
  recipients: { number: string; status: string; conversationId: string | null }[];
}

// --------------------------------------------------------------------- errors

export const ExitCode = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  AUTH: 3,
  UNSUPPORTED: 4,
  NOT_FOUND: 5,
  /**
   * "I did nothing, and you have to decide something." Two distinct `code`s
   * share it: `ambiguous_target` (more than one candidate — pick one) and
   * `confirm_required` (a human has to say yes first). Read `code`, not just
   * the exit status, before choosing what to do next.
   */
  AMBIGUOUS: 6,
  UPSTREAM: 7,
} as const;

export class VoiceToolError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;
  constructor(message: string, opts: { code?: string; exitCode?: number; hint?: string | null } = {}) {
    super(message);
    this.name = 'VoiceToolError';
    this.code = opts.code ?? 'error';
    this.exitCode = opts.exitCode ?? ExitCode.UNEXPECTED;
    this.hint = opts.hint ?? null;
  }
}

export class UnsupportedCapabilityError extends VoiceToolError {
  constructor(provider: string, what: string, hint?: string) {
    super(`${provider} cannot ${what} on this install.`, {
      code: 'unsupported_capability',
      exitCode: ExitCode.UNSUPPORTED,
      hint: hint ?? null,
    });
    this.name = 'UnsupportedCapabilityError';
  }
}

export class ProviderNotAvailableError extends VoiceToolError {
  constructor(provider: string, reason: string) {
    super(`Provider "${provider}" is not available: ${reason}`, {
      code: 'provider_not_available',
      exitCode: ExitCode.UNSUPPORTED,
      hint: 'skills/voice-line/references/providers.md',
    });
    this.name = 'ProviderNotAvailableError';
  }
}

/** Any non-2xx or transport failure. status 0 = network/abort. */
export class HttpError extends VoiceToolError {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  constructor(args: {
    status: number; method: string; url: string; body?: string | null;
    message?: string; code?: string; exitCode?: number; hint?: string | null;
  }) {
    super(
      args.message ?? `${args.method} ${args.url} failed with ${args.status}`,
      { code: args.code ?? 'http_error', exitCode: args.exitCode ?? ExitCode.UPSTREAM, hint: args.hint ?? null },
    );
    this.name = 'HttpError';
    this.status = args.status;
    this.method = args.method;
    this.url = args.url;
    this.body = args.body ?? null;
  }
}

/** 401/403 — the gateway injected nothing, or the wrong thing. */
export class AuthRequiredError extends HttpError {
  constructor(args: { status: number; method: string; url: string; body?: string | null; message: string }) {
    super({ ...args, code: 'auth_required', exitCode: ExitCode.AUTH, hint: CONNECT_REFERENCE });
    this.name = 'AuthRequiredError';
  }
}

export class NotFoundError extends HttpError {
  constructor(args: { method: string; url: string; body?: string | null; message?: string }) {
    super({ ...args, status: 404, code: 'not_found', exitCode: ExitCode.NOT_FOUND });
    this.name = 'NotFoundError';
  }
}

/** More than one candidate; the tool refuses rather than guessing. */
export class AmbiguousTargetError extends VoiceToolError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'ambiguous_target', exitCode: ExitCode.AMBIGUOUS, hint: hint ?? null });
    this.name = 'AmbiguousTargetError';
  }
}

/**
 * Nothing was done because a human has not said yes yet. Same exit code as an
 * ambiguous target, different `code`: "pick one of these" and "go and get a
 * human yes" call for different next moves, and the agent reading `--json` has
 * only the envelope to tell them apart. The message carries the block to read
 * out; re-running with `--yes` is the answer.
 */
export class ConfirmationRequiredError extends VoiceToolError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'confirm_required', exitCode: ExitCode.AMBIGUOUS, hint: hint ?? null });
    this.name = 'ConfirmationRequiredError';
  }
}

// --------------------------------------------------------------- the contract
// Abstract class, not a bare interface, so shared capability guards live in one
// place.

export abstract class VoiceProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  abstract listLines(): Promise<Line[]>;
  abstract assignLine(lineId: string, personaId: string | null): Promise<Line>;
  abstract listPersonas(): Promise<Persona[]>;
  abstract getPersona(id: string): Promise<PersonaDetail>;
  abstract createPersona(input: PersonaInput): Promise<Persona>;
  abstract updatePersona(id: string, patch: Partial<PersonaInput>): Promise<Persona>;
  abstract placeCall(input: PlaceCallInput): Promise<CallHandle>;
  /** Calls plus a completeness bit. Every adapter implements THIS one. */
  abstract listCallWindow(filter: CallFilter): Promise<CallWindow>;
  abstract getCall(id: string): Promise<CallReport>;
  /** Ends a call in flight; resolves to the strategy that worked. */
  abstract hangUp(conversationId: string): Promise<HangUpStrategy>;

  submitCampaign?(input: CampaignInput): Promise<CampaignHandle>;
  getCampaign?(id: string): Promise<CampaignStatus>;
  cancelCampaign?(id: string): Promise<void>;

  /**
   * The calls alone, for every caller that only displays them. DO NOT OVERRIDE:
   * a subclass that answers this separately from its own listCallWindow can
   * drift, and the drift would be invisible at the call sites.
   */
  async listCalls(filter: CallFilter): Promise<CallSummary[]> {
    return (await this.listCallWindow(filter)).calls;
  }

  /** Uniform failure for anything this provider cannot do. */
  protected unsupported(what: string): never {
    throw new UnsupportedCapabilityError(this.name, what);
  }
}

// ------------------------------------------------------------ small helpers
// Non-breaking conveniences shared by adapters and leaf CLIs.

/** True when a status means the call is still on the wire. */
export function isLive(status: CallStatus): boolean {
  return LIVE_STATUSES.includes(status);
}
