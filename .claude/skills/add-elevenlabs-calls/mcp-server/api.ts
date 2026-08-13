/**
 * ElevenLabs Agents Platform REST client.
 *
 * No `xi-api-key` header is sent from a container: the request goes out bare and
 * the OneCLI gateway injects the vault credential in flight, so the key never
 * exists inside the container at all. `apiKey` is for `discover.ts` only, which
 * runs on the host outside the proxy with the operator's key held in the shell
 * for that one phase.
 */
import { resolveProxy, type ProxySettings } from './proxy.js';

const BASE_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 20_000;

/** How a phone number is carried, which decides the outbound-call endpoint. */
export type PhoneProvider = 'twilio' | 'sip_trunk' | 'exotel';

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const OUTBOUND_CALL_PATHS: Partial<Record<PhoneProvider, string>> = {
  twilio: '/v1/convai/twilio/outbound-call',
  sip_trunk: '/v1/convai/sip-trunk/outbound-call',
};

/**
 * Throws rather than defaulting to Twilio: an exotel number dialled through the
 * Twilio endpoint fails somewhere inside ElevenLabs, and naming the provider
 * here is the only place the operator learns what to fix.
 */
export function outboundCallPath(provider: PhoneProvider | undefined): string {
  const path = provider ? OUTBOUND_CALL_PATHS[provider] : undefined;
  if (!path) {
    throw new ElevenLabsError(
      `Cannot dial a "${provider ?? 'unknown'}" phone number — only twilio and sip_trunk numbers have an outbound-call endpoint.`,
    );
  }
  return path;
}

export interface OutboundCallBody {
  agent_id: string;
  agent_phone_number_id: string;
  to_number: string;
  conversation_initiation_client_data?: { dynamic_variables?: Record<string, string> };
}

export interface OutboundCallResult {
  success?: boolean;
  message?: string;
  conversation_id?: string;
  callSid?: string;
  sip_call_id?: string;
}

export interface TranscriptTurn {
  role?: string;
  message?: string | null;
  time_in_call_secs?: number;
}

export interface ConversationDetail {
  conversation_id: string;
  agent_id?: string;
  status?: string;
  transcript?: TranscriptTurn[];
  analysis?: {
    transcript_summary?: string;
    call_successful?: string;
    data_collection_results?: Record<string, unknown>;
  };
  metadata?: { call_duration_secs?: number; start_time_unix_secs?: number };
}

export interface ConversationListItem {
  conversation_id: string;
  agent_id?: string;
  agent_name?: string;
  status?: string;
  call_duration_secs?: number;
  start_time_unix_secs?: number;
  call_summary_title?: string;
  transcript_summary?: string;
}

export interface AgentListItem {
  agent_id: string;
  name?: string;
}

export interface AgentDetail {
  agent_id: string;
  name?: string;
  conversation_config?: unknown;
}

export interface PhoneNumber {
  phone_number_id: string;
  phone_number?: string;
  label?: string;
  provider?: PhoneProvider;
  assigned_agent?: { agent_id?: string; agent_name?: string };
}

export interface ListConversationsParams {
  agent_id: string;
  page_size?: number;
  summary_mode?: 'include' | 'exclude';
}

export interface ElevenLabsApi {
  outboundCall(provider: PhoneProvider | undefined, body: OutboundCallBody): Promise<OutboundCallResult>;
  getConversation(conversationId: string): Promise<ConversationDetail>;
  listConversations(params: ListConversationsParams): Promise<ConversationListItem[]>;
  listAgents(): Promise<AgentListItem[]>;
  getAgent(agentId: string): Promise<AgentDetail>;
  listPhoneNumbers(): Promise<PhoneNumber[]>;
}

export interface ElevenLabsClientOptions {
  /** Host-side only. Left unset in a container, where the gateway injects it. */
  apiKey?: string;
  baseUrl?: string;
}

export class ElevenLabsClient implements ElevenLabsApi {
  readonly proxy: ProxySettings;
  private readonly baseUrl: string;

  constructor(private readonly options: ElevenLabsClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BASE_URL;
    // Resolved once: the proxy does not change under a running container, and
    // re-reading /proc per request would buy nothing.
    this.proxy = resolveProxy(this.baseUrl);
  }

  protected async request<T>(
    pathname: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers['xi-api-key'] = this.options.apiKey;

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Bun-specific: the proxy has to be passed per-request because this
        // process never received the container's proxy environment. See proxy.ts.
        ...(this.proxy.proxy ? { proxy: this.proxy.proxy } : {}),
        ...(this.proxy.ca ? { tls: { ca: this.proxy.ca } } : {}),
      });
    } catch (e) {
      // Never retried: a dial that timed out may already be ringing a real
      // phone, and a retry would ring it twice.
      throw new ElevenLabsError(
        `Could not reach ElevenLabs at ${url.host}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON — keep the text so the error message can quote it */
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new ElevenLabsError(
        this.options.apiKey
          ? `ElevenLabs rejected the API key (${res.status}). It is wrong, expired, or revoked.`
          : `ElevenLabs rejected the request (${res.status}). Nothing here holds a key, so the OneCLI gateway did not inject one (${this.proxy.note}) — the vault entry needs host pattern api.elevenlabs.io, header name xi-api-key, and value format {value} with no Bearer prefix.`,
        res.status,
      );
    }
    if (res.status >= 400) {
      throw new ElevenLabsError(
        `ElevenLabs returned ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
        res.status,
      );
    }
    return body as T;
  }

  outboundCall(provider: PhoneProvider | undefined, body: OutboundCallBody): Promise<OutboundCallResult> {
    return this.request<OutboundCallResult>(outboundCallPath(provider), { method: 'POST', body });
  }

  getConversation(conversationId: string): Promise<ConversationDetail> {
    return this.request<ConversationDetail>(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  }

  async listConversations(params: ListConversationsParams): Promise<ConversationListItem[]> {
    const body = await this.request<{ conversations?: ConversationListItem[] }>('/v1/convai/conversations', {
      query: { agent_id: params.agent_id, page_size: params.page_size, summary_mode: params.summary_mode },
    });
    return body.conversations ?? [];
  }

  async listAgents(): Promise<AgentListItem[]> {
    const body = await this.request<{ agents?: AgentListItem[] }>('/v1/convai/agents', { query: { page_size: 100 } });
    return body.agents ?? [];
  }

  getAgent(agentId: string): Promise<AgentDetail> {
    return this.request<AgentDetail>(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
  }

  async listPhoneNumbers(): Promise<PhoneNumber[]> {
    const body = await this.request<PhoneNumber[] | { phone_numbers?: PhoneNumber[] }>('/v1/convai/phone-numbers');
    return Array.isArray(body) ? body : (body.phone_numbers ?? []);
  }
}

const MAX_TRANSCRIPT_TURNS = 60;
const MAX_TURN_CHARS = 400;

export interface CallReport {
  conversation_id: string;
  status: string;
  duration_secs: number | null;
  summary: string | null;
  call_successful: string | null;
  data_collection_results: Record<string, unknown> | null;
  transcript: { role: string; message: string }[];
  transcript_total_turns?: number;
}

/**
 * The trimmed form of a conversation, small enough to travel as gate-script
 * output (capped at 1MB) and to be read by an agent that has to summarize it.
 * Keeping the tail rather than the head when a call runs long is deliberate:
 * how it ended is what gets reported.
 */
export function summarizeConversation(conv: ConversationDetail): CallReport {
  const turns = (conv.transcript ?? [])
    .map((turn) => ({ role: turn.role ?? 'unknown', message: (turn.message ?? '').trim() }))
    .filter((turn) => turn.message.length > 0)
    .map((turn) => ({
      role: turn.role,
      message: turn.message.length > MAX_TURN_CHARS ? `${turn.message.slice(0, MAX_TURN_CHARS)}…` : turn.message,
    }));
  const kept = turns.slice(-MAX_TRANSCRIPT_TURNS);

  return {
    conversation_id: conv.conversation_id,
    status: conv.status ?? 'unknown',
    duration_secs: conv.metadata?.call_duration_secs ?? null,
    summary: conv.analysis?.transcript_summary ?? null,
    call_successful: conv.analysis?.call_successful ?? null,
    data_collection_results: conv.analysis?.data_collection_results ?? null,
    transcript: kept,
    ...(kept.length < turns.length ? { transcript_total_turns: turns.length } : {}),
  };
}
