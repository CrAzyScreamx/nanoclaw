/**
 * client.ts — the ElevenLabs REST surface, one method per endpoint.
 *
 * This file does transport only: it builds a URL, hands it to `lib/http.ts`,
 * and returns the raw wire shape. No mapping onto the domain model happens
 * here (that is `provider.ts`), and no credential is ever read or set — the
 * OneCLI gateway injects `xi-api-key` by destination host, so every request
 * below deliberately carries no auth header. A 401/403 comes back from
 * `lib/http.ts` as an AuthRequiredError already pointing at
 * `skills/voice-line/references/connect-provider.md`; nothing here retries it.
 */

import { request, requestVoid } from '../../lib/http.ts';
import { UnsupportedCapabilityError, type CarrierKind } from '../../lib/provider.ts';
import type {
  ElAgentDetail,
  ElAgentListResponse,
  ElAgentSummary,
  ElAgentWriteBody,
  ElBatchResponse,
  ElBatchSubmitRequest,
  ElConversationDetail,
  ElConversationListResponse,
  ElConversationSummary,
  ElOutboundCallBody,
  ElOutboundCallResponse,
  ElPhoneNumber,
} from './types.ts';

const SERVICE = 'ElevenLabs';

/**
 * Every ElevenLabs path is built here. lib/http.ts is provider-neutral and must
 * stay free of any provider host — the carriers reach it with absolute URLs of
 * their own.
 */
const BASE = 'https://api.elevenlabs.io';

function el(path: string): string {
  return BASE + (path.startsWith('/') ? path : `/${path}`);
}

/** Hard ceiling on cursor-following, so a sweep can never run away. */
const MAX_PAGES = 10;
const DEFAULT_PAGE_SIZE = 30;

/** The three outbound routes. The carrier decides; there is no default. */
const OUTBOUND_PATHS: Record<CarrierKind, string> = {
  twilio: '/v1/convai/twilio/outbound-call',
  exotel: '/v1/convai/exotel/outbound-call',
  sip_trunk: '/v1/convai/sip-trunk/outbound-call',
};

export interface ListAgentsParams {
  page_size?: number;
  cursor?: string;
  limit?: number;
}

export interface ListConversationsParams {
  agent_id?: string;
  call_start_after_unix?: number;
  page_size?: number;
  cursor?: string;
  limit?: number;
  /** Wall-clock ceiling for the whole cursor walk. */
  budgetMs?: number;
  /** Per-request timeout; a sweep uses a short one so one hung page cannot eat its budget. */
  timeoutMs?: number;
}

/**
 * Rows, plus whether the cursor walk reached the end of the server's answer.
 * `complete: false` means rows matching the query were left unread — the limit,
 * MAX_PAGES or the time budget stopped the walk while `has_more` was still true.
 * The endpoint answers NEWEST first, so what is left unread is always the OLDEST
 * part of the window.
 */
export interface ConversationWindow {
  rows: ElConversationSummary[];
  complete: boolean;
}

export class ElevenLabsClient {
  // ------------------------------------------------------------- phone numbers

  listPhoneNumbers(): Promise<ElPhoneNumber[]> {
    return request<ElPhoneNumber[]>(el('/v1/convai/phone-numbers'), {
      method: 'GET',
      service: SERVICE,
    });
  }

  patchPhoneNumber(id: string, body: { agent_id: string | null }): Promise<ElPhoneNumber> {
    return request<ElPhoneNumber>(el(`/v1/convai/phone-numbers/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      json: body,
      service: SERVICE,
    });
  }

  // -------------------------------------------------------------------- agents

  /** One page. Callers wanting the whole list use `listAllAgents`. */
  listAgents(params: ListAgentsParams = {}): Promise<ElAgentListResponse> {
    return request<ElAgentListResponse>(el('/v1/convai/agents'), {
      method: 'GET',
      query: {
        page_size: params.page_size ?? DEFAULT_PAGE_SIZE,
        cursor: params.cursor,
      },
      service: SERVICE,
    });
  }

  /** Follows `next_cursor` while `has_more`, stopping at `limit` or MAX_PAGES. */
  async listAllAgents(params: ListAgentsParams = {}): Promise<ElAgentSummary[]> {
    const limit = params.limit ?? Number.POSITIVE_INFINITY;
    const pageSize = params.page_size ?? DEFAULT_PAGE_SIZE;
    const out: ElAgentSummary[] = [];
    let cursor = params.cursor;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await this.listAgents({ page_size: pageSize, cursor });
      for (const agent of res.agents ?? []) {
        out.push(agent);
        if (out.length >= limit) return out;
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  getAgent(id: string): Promise<ElAgentDetail> {
    return request<ElAgentDetail>(el(`/v1/convai/agents/${encodeURIComponent(id)}`), {
      method: 'GET',
      service: SERVICE,
    });
  }

  createAgent(body: ElAgentWriteBody): Promise<ElAgentDetail> {
    return request<ElAgentDetail>(el('/v1/convai/agents/create'), {
      method: 'POST',
      json: body,
      service: SERVICE,
    });
  }

  patchAgent(id: string, body: ElAgentWriteBody): Promise<ElAgentDetail> {
    return request<ElAgentDetail>(el(`/v1/convai/agents/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      json: body,
      service: SERVICE,
    });
  }

  // ------------------------------------------------------------------ outbound

  /**
   * The route is chosen by the line's carrier and is NEVER defaulted: dialing a
   * SIP number through the Twilio route fails in a way that looks like an auth
   * problem, so an unknown carrier is a hard error instead.
   */
  outboundCall(carrier: CarrierKind, body: ElOutboundCallBody): Promise<ElOutboundCallResponse> {
    const path = OUTBOUND_PATHS[carrier];
    if (!path) {
      throw new UnsupportedCapabilityError(
        'elevenlabs',
        `place an outbound call on carrier "${String(carrier)}"`,
        'Known carriers are twilio, exotel and sip_trunk. Run `lines.ts list` to re-detect the carrier for this line.',
      );
    }
    return request<ElOutboundCallResponse>(el(path), {
      method: 'POST',
      json: body,
      service: SERVICE,
    });
  }

  // ------------------------------------------------------------- conversations

  /** One page. */
  listConversations(params: ListConversationsParams = {}): Promise<ElConversationListResponse> {
    return request<ElConversationListResponse>(el('/v1/convai/conversations'), {
      method: 'GET',
      query: {
        agent_id: params.agent_id,
        call_start_after_unix: params.call_start_after_unix,
        page_size: params.page_size ?? DEFAULT_PAGE_SIZE,
        cursor: params.cursor,
      },
      timeoutMs: params.timeoutMs,
      service: SERVICE,
    });
  }

  /**
   * Follows `next_cursor` while `has_more`, stopping at `limit`, MAX_PAGES or
   * the time budget — and SAYS WHICH. Only a walk that ran out of `has_more`
   * reports `complete: true`; every early exit reports false, including the
   * exactly-`limit`-rows case, where the current page's `has_more` was never
   * consulted. Conservative on purpose: see CallWindow in lib/provider.ts.
   */
  async listAllConversationsWindow(params: ListConversationsParams = {}): Promise<ConversationWindow> {
    const limit = params.limit ?? Number.POSITIVE_INFINITY;
    const pageSize = params.page_size ?? DEFAULT_PAGE_SIZE;
    const deadline = params.budgetMs === undefined ? null : Date.now() + params.budgetMs;
    const rows: ElConversationSummary[] = [];
    let cursor = params.cursor;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (deadline !== null && Date.now() >= deadline) return { rows, complete: false };
      const res = await this.listConversations({
        agent_id: params.agent_id,
        call_start_after_unix: params.call_start_after_unix,
        page_size: pageSize,
        cursor,
        timeoutMs: params.timeoutMs,
      });
      for (const conversation of res.conversations ?? []) {
        rows.push(conversation);
        if (rows.length >= limit) return { rows, complete: false };
      }
      if (!res.has_more || !res.next_cursor) return { rows, complete: true };
      cursor = res.next_cursor;
    }
    // Fell out of the page loop with has_more still true.
    return { rows, complete: false };
  }

  /** The rows alone, for callers that do not advance a watermark. */
  async listAllConversations(params: ListConversationsParams = {}): Promise<ElConversationSummary[]> {
    return (await this.listAllConversationsWindow(params)).rows;
  }

  getConversation(id: string): Promise<ElConversationDetail> {
    return request<ElConversationDetail>(el(`/v1/convai/conversations/${encodeURIComponent(id)}`), {
      method: 'GET',
      service: SERVICE,
    });
  }

  // ---------------------------------------------------------------- campaigns

  submitBatch(body: ElBatchSubmitRequest): Promise<ElBatchResponse> {
    return request<ElBatchResponse>(el('/v1/convai/batch-calling/submit'), {
      method: 'POST',
      json: body,
      service: SERVICE,
    });
  }

  getBatch(id: string): Promise<ElBatchResponse> {
    return request<ElBatchResponse>(el(`/v1/convai/batch-calling/${encodeURIComponent(id)}`), {
      method: 'GET',
      service: SERVICE,
    });
  }

  cancelBatch(id: string): Promise<void> {
    return requestVoid(el(`/v1/convai/batch-calling/${encodeURIComponent(id)}/cancel`), {
      method: 'POST',
      service: SERVICE,
    });
  }
}

export default ElevenLabsClient;
