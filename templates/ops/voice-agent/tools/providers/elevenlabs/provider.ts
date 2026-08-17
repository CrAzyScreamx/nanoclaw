/**
 * provider.ts — ElevenLabs, mapped onto the neutral domain model.
 *
 * This directory is the only place allowed to speak both languages, and this
 * file is its entry point (`call-mapping.ts` and `persona-body.ts` are its
 * mappers). Everything above it sees `Line`/`Persona`/`CallSummary`; everything
 * below it sees `phone_number_id`/`agent_id`. No credential is read here either
 * — the OneCLI gateway injects `xi-api-key` by destination host.
 */

import {
  AmbiguousTargetError, ExitCode, isLive, UnsupportedCapabilityError,
  VoiceProvider, VoiceToolError,
  type CallFilter, type CallHandle, type CallReport, type CallWindow,
  type CampaignHandle, type CampaignInput, type CampaignStatus, type CarrierKind, type CarrierValue,
  type HangUpStrategy, type Line, type Persona, type PersonaDetail, type PersonaInput,
  type PlaceCallInput, type ProviderCapabilities,
} from '../../lib/provider.ts';
import { getLineConfig, readConfig, recordLines } from '../../lib/state.ts';
import { carrierFor, hangUpStrategies } from '../../carriers/index.ts';
import { CARRIER_KINDS, mapCarrier, toReport, toSummary } from './call-mapping.ts';
import { ElevenLabsClient } from './client.ts';
import { monitorAvailability, monitorEndCall } from './monitor.ts';
import { buildAgentBody, isEndCallTool } from './persona-body.ts';
import type {
  ElAgentDetail, ElAgentSummary, ElAgentTool, ElBatchResponse, ElPhoneNumber,
} from './types.ts';

const HANGUP_REFERENCE = 'skills/voice-line/references/ending-a-call.md';

/**
 * Direction, status and `live` are filtered after the fetch, so asking for N
 * rows has to READ more than N or a busy line answers a `--limit 30` with two
 * matches. Callers that need a different budget say so with `filter.scan`.
 */
const DEFAULT_SCAN_MULTIPLE = 3;
const DEFAULT_SCAN_MAX = 300;
const PAGE_TIMEOUT_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class ElevenLabsProvider extends VoiceProvider {
  readonly name = 'elevenlabs';
  private readonly client: ElevenLabsClient;

  constructor(client: ElevenLabsClient = new ElevenLabsClient()) {
    super();
    this.client = client;
  }

  /**
   * Resolved, not hardcoded: `carrier` appears only when a recorded line sits on
   * a fully configured carrier, and `monitor` only when the monitor channel has
   * been enabled after being seen to work. An empty array means this install
   * cannot end a call in flight, and callers must say so plainly.
   */
  get capabilities(): ProviderCapabilities {
    const strategies: HangUpStrategy[] = [...hangUpStrategies(readConfig())];
    if (monitorAvailability().available) strategies.push('monitor');
    return {
      inbound: 'managed', outbound: true, campaigns: true,
      personaManagement: true, transcripts: true, hangUp: strategies,
    };
  }

  // ---------------------------------------------------------------- lines

  private toLine(raw: ElPhoneNumber): Line {
    const assigned = raw.assigned_agent ?? null;
    return {
      id: raw.phone_number_id,
      number: raw.phone_number,
      label: raw.label && raw.label.length > 0 ? raw.label : raw.phone_number,
      // A carrier value we do not recognise is passed through as-is rather than
      // defaulted to a known one: `carrierFor` refuses it by name, and the
      // outbound route refuses it too, which is the honest outcome. Silently
      // calling it "sip_trunk" would dial down the wrong route. The domain type
      // is CarrierValue, so this widening is visible rather than cast away.
      carrier: mapCarrier(raw.provider) ?? (raw.provider || 'unknown'),
      answeredBy: assigned?.agent_id
        ? { id: assigned.agent_id, name: assigned.agent_name ?? assigned.agent_id }
        : null,
    };
  }

  async listLines(): Promise<Line[]> {
    const raw = await this.client.listPhoneNumbers();
    const rows = Array.isArray(raw)
      ? raw
      : ((asRecord(raw)?.phone_numbers as ElPhoneNumber[] | undefined) ?? []);
    const lines = rows.filter((row) => row && row.phone_number_id).map((row) => this.toLine(row));
    // Side effect on purpose: the carrier per line decides which hang-up route
    // exists, and setup must know that before anyone asks to end a call.
    recordLines(lines);
    return lines;
  }

  async assignLine(lineId: string, personaId: string | null): Promise<Line> {
    await this.client.patchPhoneNumber(lineId, { agent_id: personaId });
    const lines = await this.listLines();
    const line = lines.find((candidate) => candidate.id === lineId);
    if (!line) {
      throw new VoiceToolError(`Line ${lineId} was updated but is no longer listed on this account.`,
        { code: 'not_found', exitCode: ExitCode.NOT_FOUND });
    }
    return line;
  }

  // -------------------------------------------------------------- personas

  private toPersona(raw: ElAgentSummary | ElAgentDetail): Persona {
    const createdAt = (raw as ElAgentSummary).created_at_unix_secs;
    return {
      id: raw.agent_id,
      name: raw.name ?? raw.agent_id,
      createdAt: typeof createdAt === 'number' ? createdAt : null,
    };
  }

  async listPersonas(): Promise<Persona[]> {
    const agents = await this.client.listAllAgents({ limit: 200 });
    return agents.filter((agent) => agent && agent.agent_id).map((agent) => this.toPersona(agent));
  }

  async getPersona(id: string): Promise<PersonaDetail> {
    const raw = await this.client.getAgent(id);
    const agentCfg = raw.conversation_config?.agent;
    const toolEntries = agentCfg?.prompt?.tools ?? [];
    const tools = toolEntries
      .map((tool) => tool?.name ?? tool?.type)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const toolIds = agentCfg?.prompt?.tool_ids ?? [];
    return {
      ...this.toPersona(raw),
      prompt: agentCfg?.prompt?.prompt ?? '',
      firstMessage: agentCfg?.first_message ?? '',
      language: agentCfg?.language ?? 'en',
      voiceId: raw.conversation_config?.tts?.voice_id ?? null,
      tools: [...new Set([...tools, ...toolIds])],
      hasEndCallTool: toolEntries.some(isEndCallTool),
    };
  }

  async createPersona(input: PersonaInput): Promise<Persona> {
    if (!input.name) {
      throw new VoiceToolError('A persona needs a name.', { code: 'usage', exitCode: ExitCode.USAGE });
    }
    const created = await this.client.createAgent(buildAgentBody(input, true));
    return this.toPersona(created);
  }

  async updatePersona(id: string, patch: Partial<PersonaInput>): Promise<Persona> {
    // Toggling the end_call tool is read-modify-write, so the current tool list
    // is fetched first — but only when the toggle is actually part of the patch,
    // so an ordinary rename still costs one request.
    let currentTools: ElAgentTool[] | undefined;
    let effective = patch;
    if (patch.endCallTool !== undefined) {
      const existing = await this.client.getAgent(id);
      const existingPrompt = existing.conversation_config?.agent?.prompt;
      currentTools = existingPrompt?.tools ?? [];
      // UNVERIFIED: whether PATCH /v1/convai/agents/{id} merges or replaces the
      // `prompt` object is not documented. Carrying the existing prompt text
      // through is safe either way; without it, a replace would blank it.
      if (patch.prompt === undefined && typeof existingPrompt?.prompt === 'string') {
        effective = { ...patch, prompt: existingPrompt.prompt };
      }
    }

    const body = buildAgentBody(effective, false, currentTools);
    if (Object.keys(body).length === 0) {
      throw new VoiceToolError('Nothing to update: no persona fields were given.',
        { code: 'usage', exitCode: ExitCode.USAGE });
    }
    const updated = await this.client.patchAgent(id, body);
    return this.toPersona(updated);
  }

  // ----------------------------------------------------------------- calls

  /** The carrier is never defaulted: the wrong outbound route fails obscurely. */
  private async resolveCarrier(lineId: string, provided?: CarrierValue): Promise<CarrierKind> {
    const recorded = mapCarrier(getLineConfig(lineId)?.carrier);
    if (recorded) return recorded;

    // Re-mapped rather than trusted: a line can report a carrier value that is
    // not one of the three routable kinds, and there is no outbound route for it.
    const refreshed = mapCarrier((await this.listLines()).find((line) => line.id === lineId)?.carrier);
    if (refreshed) return refreshed;

    const fallback = mapCarrier(provided);
    if (fallback) return fallback;

    throw new VoiceToolError(
      `The carrier for line ${lineId} is unknown, so there is no outbound route to choose. ` +
        'Run `lines.ts list` first — it reads each line\'s carrier from ElevenLabs and records it.',
      { code: 'carrier_unknown', exitCode: ExitCode.USAGE },
    );
  }

  async placeCall(input: PlaceCallInput): Promise<CallHandle> {
    const carrier = await this.resolveCarrier(input.lineId, input.carrier);
    const variables = input.variables ?? {};
    const response = await this.client.outboundCall(carrier, {
      agent_id: input.personaId,
      agent_phone_number_id: input.lineId,
      to_number: input.toNumber,
      ...(Object.keys(variables).length > 0
        ? { conversation_initiation_client_data: { dynamic_variables: variables } }
        : {}),
    });

    return {
      conversationId: response.conversation_id ?? '',
      callSid: response.callSid ?? response.sip_call_id ?? null,
      carrier,
      accepted: response.success !== false && Boolean(response.conversation_id),
      message: response.message ?? null,
    };
  }

  /**
   * The list response already carries direction, status, outcome and summary,
   * so a sweep needs no detail fetch per call. Direction / status / live are
   * filtered client-side because the endpoint does not take them.
   *
   * `complete` describes the UPSTREAM read only: true means everything matching
   * `startedAfter` was seen. The client-side `limit` slice can still drop rows
   * from a complete window, but only ever the NEWEST ones (the sort below puts
   * the oldest first), which is why that slice cannot hide anything from a
   * watermark that never advances past what it reported.
   */
  async listCallWindow(filter: CallFilter): Promise<CallWindow> {
    const limit = filter.limit ?? 30;
    const scan = filter.scan ?? Math.min(DEFAULT_SCAN_MAX, limit * DEFAULT_SCAN_MULTIPLE);
    const { rows, complete } = await this.client.listAllConversationsWindow({
      agent_id: filter.personaId,
      call_start_after_unix: filter.startedAfter,
      page_size: Math.min(100, Math.max(limit, 30)),
      cursor: filter.cursor,
      limit: scan,
      budgetMs: filter.scanBudgetMs,
      // A caller on a clock needs one hung page to fail fast rather than eat the
      // whole walk: http.ts's 30s default is longer than the sweep's own budget.
      timeoutMs: filter.scanBudgetMs === undefined
        ? undefined
        : Math.min(PAGE_TIMEOUT_MS, filter.scanBudgetMs),
    });

    const calls = rows.filter((row) => row && row.conversation_id).map((row) => toSummary(row));
    const matched = calls.filter((call) => {
      if (filter.direction && call.direction !== filter.direction) return false;
      if (filter.status && call.status !== filter.status) return false;
      if (filter.live && !isLive(call.status)) return false;
      return true;
    });

    // The endpoint answers newest-first, so slicing straight away would keep the
    // NEWEST `limit` rows. A caller that advances a watermark past what it read
    // (the sweep) must be handed the OLDEST end of the window instead, or the
    // rows it never saw fall below the new watermark and are lost for good.
    // Rows with no start time sort to the front on purpose: they are the ones a
    // start-time watermark cannot reason about, so a sweep must see them.
    const ordered = filter.oldestFirst
      ? [...matched].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      : matched;
    return { calls: ordered.slice(0, limit), complete };
  }

  async getCall(id: string): Promise<CallReport> {
    return toReport(await this.client.getConversation(id));
  }

  // -------------------------------------------------------------- hang-up

  async hangUp(conversationId: string): Promise<HangUpStrategy> {
    const report = await this.getCall(conversationId);
    if (!isLive(report.status)) {
      throw new VoiceToolError(
        `Conversation ${conversationId} is "${report.status}", not live — there is nothing to hang up.`,
        { code: 'not_live', exitCode: ExitCode.USAGE, hint: HANGUP_REFERENCE },
      );
    }

    const cfg = readConfig();
    const carrier = carrierFor(report.carrier, cfg);
    if (carrier.unavailable === null) {
      await carrier.endCall(report.callSid ?? '');
      return 'carrier';
    }

    const monitor = monitorAvailability();
    if (monitor.available) {
      await monitorEndCall(conversationId);
      return 'monitor';
    }

    throw new UnsupportedCapabilityError(
      this.name,
      `end conversation ${conversationId} in flight — the carrier route is unavailable (${carrier.unavailable}), ` +
        `and the monitor route is unavailable (${monitor.reason ?? 'no reason recorded'})`,
      'The always-available fallback is the `end_call` system tool on the persona, which lets the voice ' +
        'agent hang up itself when its stopping conditions are met — see ' +
        HANGUP_REFERENCE,
    );
  }

  // ------------------------------------------------------------ campaigns

  private toCampaignHandle(raw: ElBatchResponse): CampaignHandle {
    return {
      id: raw.id, name: raw.name ?? raw.id, status: raw.status ?? 'unknown',
      total: raw.total_calls_scheduled ?? raw.recipients?.length ?? 0,
    };
  }

  async submitCampaign(input: CampaignInput): Promise<CampaignHandle> {
    if (input.recipients.length === 0) {
      throw new VoiceToolError('A campaign needs at least one recipient.',
        { code: 'usage', exitCode: ExitCode.USAGE });
    }
    const seen = new Set<string>();
    for (const recipient of input.recipients) {
      if (seen.has(recipient.number)) {
        throw new AmbiguousTargetError(
          `${recipient.number} appears more than once in this campaign; dialing the same number twice ` +
            'is almost never intended, so nothing was submitted.',
        );
      }
      seen.add(recipient.number);
    }

    // Resolve the carrier first, so an undetected line fails here rather than
    // after a batch has been dispatched.
    await this.resolveCarrier(input.lineId);

    const response = await this.client.submitBatch({
      call_name: input.name,
      agent_id: input.personaId,
      agent_phone_number_id: input.lineId,
      scheduled_time_unix: input.scheduledAt ?? null,
      recipients: input.recipients.map((recipient) => ({
        phone_number: recipient.number,
        ...(recipient.variables && Object.keys(recipient.variables).length > 0
          ? { conversation_initiation_client_data: { dynamic_variables: recipient.variables } }
          : {}),
      })),
    });
    return this.toCampaignHandle(response);
  }

  async getCampaign(id: string): Promise<CampaignStatus> {
    const raw = await this.client.getBatch(id);
    const recipients = (raw.recipients ?? []).map((recipient) => ({
      number: recipient.phone_number ?? '',
      status: recipient.status ?? 'unknown',
      conversationId: recipient.conversation_id ?? null,
    }));
    const completed = recipients.filter((r) => ['completed', 'done'].includes(r.status.toLowerCase())).length;
    const failed = recipients.filter((r) => ['failed', 'cancelled', 'canceled'].includes(r.status.toLowerCase())).length;
    return {
      ...this.toCampaignHandle(raw),
      dispatched: raw.total_calls_dispatched ?? recipients.filter((r) => r.conversationId).length,
      completed,
      failed,
      recipients,
    };
  }

  async cancelCampaign(id: string): Promise<void> {
    await this.client.cancelBatch(id);
  }
}

export default ElevenLabsProvider;
