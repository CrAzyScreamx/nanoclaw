/**
 * Per-group ElevenLabs config for the `elevenlabs` stdio MCP server.
 *
 * One file, `config.json`, under `/workspace/agent/elevenlabs/`: which voice
 * agents this group may dial, which number each one dials from, which
 * `{{placeholders}}` each one needs filled, and which of the four tools are
 * built. Written by `/add-elevenlabs-calls`.
 *
 * It holds no secret. The API key lives in the OneCLI vault and is injected into
 * requests by the gateway, so there is nothing here to protect with a file mode.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { PhoneProvider } from './api.js';
import type { DynamicVariable, VariableSource } from './variables.js';

export const CONFIG_DIR = process.env.EL_CONFIG_DIR || '/workspace/agent/elevenlabs';

export const CAPABILITIES = ['list_agents', 'start_call', 'get_call', 'list_conversations'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface AgentEntry {
  agent_id: string;
  name: string;
  phone_number_id?: string;
  phone_number?: string;
  provider?: PhoneProvider;
  dynamic_variables: DynamicVariable[];
}

/** How the `el-call-*` task series that reports a finished call is scheduled. */
export interface PollConfig {
  recurrence: string;
  deadline_minutes: number;
}

export interface Config {
  capabilities: Capability[];
  poll: PollConfig;
  agents: AgentEntry[];
}

export const DEFAULT_POLL: PollConfig = { recurrence: '*/2 * * * *', deadline_minutes: 30 };

export class ConfigError extends Error {}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${what} must be a non-empty string`);
  return value.trim();
}

function parseCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) throw new ConfigError('capabilities must be an array');
  return value.map((entry, i) => {
    const name = asString(entry, `capabilities[${i}]`);
    // A typo here would otherwise present as a tool that silently never
    // appears, which is indistinguishable from "the operator turned it off".
    if (!(CAPABILITIES as readonly string[]).includes(name)) {
      throw new ConfigError(`Unknown capability "${name}" — expected one of ${CAPABILITIES.join(', ')}`);
    }
    return name as Capability;
  });
}

/** Accepts `"customer_name"` as well as `{name, used_in}`, so a hand-edit works. */
function parseVariables(value: unknown, what: string): DynamicVariable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${what} must be an array`);
  return value.map((entry, i) => {
    if (typeof entry === 'string') return { name: asString(entry, `${what}[${i}]`), used_in: [] };
    const obj = asObject(entry, `${what}[${i}]`);
    const usedIn = Array.isArray(obj.used_in)
      ? (obj.used_in.filter((s) => typeof s === 'string') as VariableSource[])
      : [];
    return { name: asString(obj.name, `${what}[${i}].name`), used_in: usedIn };
  });
}

function parseAgent(value: unknown, index: number): AgentEntry {
  const obj = asObject(value, `agents[${index}]`);
  const agentId = asString(obj.agent_id, `agents[${index}].agent_id`);
  return {
    agent_id: agentId,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : agentId,
    ...(typeof obj.phone_number_id === 'string' ? { phone_number_id: obj.phone_number_id } : {}),
    ...(typeof obj.phone_number === 'string' ? { phone_number: obj.phone_number } : {}),
    ...(typeof obj.provider === 'string' ? { provider: obj.provider as PhoneProvider } : {}),
    dynamic_variables: parseVariables(obj.dynamic_variables, `agents[${index}].dynamic_variables`),
  };
}

function parsePoll(value: unknown): PollConfig {
  if (value === undefined) return DEFAULT_POLL;
  const obj = asObject(value, 'poll');
  const minutes =
    typeof obj.deadline_minutes === 'number' && obj.deadline_minutes > 0
      ? obj.deadline_minutes
      : DEFAULT_POLL.deadline_minutes;
  return {
    recurrence:
      typeof obj.recurrence === 'string' && obj.recurrence.trim() ? obj.recurrence.trim() : DEFAULT_POLL.recurrence,
    deadline_minutes: minutes,
  };
}

export function parseConfig(value: unknown): Config {
  const obj = asObject(value, 'config.json');
  const agents = obj.agents === undefined ? [] : Array.isArray(obj.agents) ? obj.agents : null;
  if (agents === null) throw new ConfigError('agents must be an array');
  return {
    capabilities: parseCapabilities(obj.capabilities),
    poll: parsePoll(obj.poll),
    agents: agents.map(parseAgent),
  };
}

export function loadConfig(dir: string = CONFIG_DIR): Config {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) {
    throw new ConfigError(`No ElevenLabs config at ${file} — this agent group is not enabled`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(parsed);
}

/**
 * The allowlist lookup. Ids are matched before names so an agent literally named
 * after another one's id cannot shadow it.
 */
export function findAgent(agents: AgentEntry[], ref: string): AgentEntry | undefined {
  const needle = ref.trim().toLowerCase();
  return (
    agents.find((agent) => agent.agent_id.toLowerCase() === needle) ??
    agents.find((agent) => agent.name.toLowerCase() === needle)
  );
}
