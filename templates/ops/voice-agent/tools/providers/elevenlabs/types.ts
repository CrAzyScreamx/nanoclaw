/**
 * types.ts — wire shapes for the ElevenLabs `/v1/convai/*` endpoints.
 *
 * Declarations only, no logic. Everything here is ElevenLabs vocabulary
 * (`phone_number_id`, `agent_id`, …) and MUST NOT leak past
 * `providers/elevenlabs/provider.ts`, which maps these onto the neutral domain
 * types in `../../lib/provider.ts`.
 *
 * Every field except the primary id is optional on purpose. The shapes below
 * were written from the public API documentation, not from a captured
 * response, so `provider.ts` parses defensively and never assumes presence.
 */

// ------------------------------------------------------------------ numbers

export interface ElAssignedAgent {
  agent_id: string;
  agent_name?: string;
}

export interface ElPhoneNumber {
  phone_number_id: string;
  phone_number: string;
  label?: string;
  /** The phone network the number is carried on. */
  provider: 'twilio' | 'sip_trunk' | 'exotel';
  assigned_agent?: ElAssignedAgent | null;
}

// ------------------------------------------------------------------- agents

export interface ElAgentSummary {
  agent_id: string;
  name: string;
  created_at_unix_secs?: number;
  tags?: string[];
}

export interface ElAgentListResponse {
  agents: ElAgentSummary[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface ElAgentTool {
  type?: string;
  name?: string;
}

export interface ElAgentPrompt {
  prompt?: string;
  llm?: string;
  tool_ids?: string[];
  tools?: ElAgentTool[];
}

export interface ElConversationConfigAgent {
  prompt?: ElAgentPrompt;
  first_message?: string;
  language?: string;
}

export interface ElConversationConfigTts {
  voice_id?: string;
  model_id?: string;
}

export interface ElConversationConfig {
  agent?: ElConversationConfigAgent;
  tts?: ElConversationConfigTts;
}

export interface ElAgentDetail {
  agent_id: string;
  name: string;
  conversation_config?: ElConversationConfig;
  platform_settings?: Record<string, unknown>;
}

/** Body accepted by both `POST /agents/create` and `PATCH /agents/{id}`. */
export interface ElAgentWriteBody {
  name?: string;
  conversation_config?: ElConversationConfig;
  [key: string]: unknown;
}

// ----------------------------------------------------------------- outbound

export interface ElOutboundCallBody {
  agent_id: string;
  agent_phone_number_id: string;
  to_number: string;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, string>;
  };
}

export interface ElOutboundCallResponse {
  success?: boolean;
  message?: string;
  conversation_id?: string;
  /** Twilio / Exotel return a carrier call id here; SIP trunks use sip_call_id. */
  callSid?: string;
  sip_call_id?: string;
}

// ------------------------------------------------------------ conversations

export type ElConversationStatus =
  | 'initiated'
  | 'in-progress'
  | 'processing'
  | 'done'
  | 'failed';

export type ElCallSuccessful = 'success' | 'failure' | 'unknown';

export interface ElConversationSummary {
  conversation_id: string;
  agent_id?: string;
  agent_name?: string;
  start_time_unix_secs?: number;
  call_duration_secs?: number;
  message_count?: number;
  status?: ElConversationStatus;
  call_successful?: ElCallSuccessful;
  transcript_summary?: string;
  call_summary_title?: string;
  direction?: 'inbound' | 'outbound';
}

export interface ElConversationListResponse {
  conversations: ElConversationSummary[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface ElTranscriptTurn {
  role?: 'agent' | 'user';
  message?: string | null;
  time_in_call_secs?: number;
}

export interface ElPhoneCallMetadata {
  direction?: 'inbound' | 'outbound';
  phone_number_id?: string;
  agent_number?: string;
  external_number?: string;
  /** The carrier that carried this call — the key to which hang-up route works. */
  type?: 'twilio' | 'exotel' | 'sip_trunk';
  call_sid?: string;
  stream_sid?: string;
}

export interface ElConversationMetadata {
  start_time_unix_secs?: number;
  call_duration_secs?: number;
  phone_call?: ElPhoneCallMetadata;
}

export interface ElDataCollectionResult {
  value?: unknown;
  rationale?: string;
}

export interface ElConversationAnalysis {
  call_successful?: ElCallSuccessful;
  transcript_summary?: string;
  data_collection_results?: Record<string, ElDataCollectionResult>;
}

export interface ElConversationDetail extends ElConversationSummary {
  transcript?: ElTranscriptTurn[];
  metadata?: ElConversationMetadata;
  analysis?: ElConversationAnalysis;
}

// ---------------------------------------------------------------- campaigns

export interface ElBatchRecipientRequest {
  phone_number: string;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, string>;
  };
}

export interface ElBatchSubmitRequest {
  call_name: string;
  agent_id: string;
  agent_phone_number_id: string;
  recipients: ElBatchRecipientRequest[];
  /** unix seconds; omit or null to start immediately. */
  scheduled_time_unix?: number | null;
}

export interface ElBatchRecipient {
  id?: string;
  phone_number?: string;
  status?: string;
  conversation_id?: string | null;
}

export interface ElBatchResponse {
  id: string;
  name?: string;
  status?: string;
  total_calls_scheduled?: number;
  total_calls_dispatched?: number;
  agent_id?: string;
  phone_number_id?: string;
  scheduled_time_unix?: number | null;
  recipients?: ElBatchRecipient[];
}
