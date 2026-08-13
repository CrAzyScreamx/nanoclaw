/**
 * How the ElevenLabs tools present themselves, and how their answers come back.
 *
 * The agent and dynamic-variable snapshot lives in the tool *descriptions*
 * rather than in the container skill, because `container/skills/` is a single
 * global read-only mount: anything written there would show every group every
 * other group's agents and phone numbers. A description is built per group from
 * that group's config.json, so it can only ever describe what this group may
 * dial.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { ElevenLabsError } from '../api.js';
import type { AgentEntry } from '../config.js';

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function json(value: unknown): CallToolResult {
  return ok(JSON.stringify(value, null, 2));
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/**
 * One place where a thrown ElevenLabsError becomes a tool error. Anything else
 * is a bug in this server and is reported as such rather than dressed up as an
 * ElevenLabs problem — the two need different fixes.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ElevenLabsError) return fail(e.message);
    return fail(`elevenlabs-mcp internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function record(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function requiredVariables(agent: AgentEntry): string[] {
  return agent.dynamic_variables.map((variable) => variable.name);
}

/** `"Reception" (agent_01xyz), "Reminder" (agent_01abc)` — for error messages. */
export function agentRefs(agents: AgentEntry[]): string {
  return agents.map((agent) => `"${agent.name}" (${agent.agent_id})`).join(', ') || '(none)';
}

export function agentSnapshot(agents: AgentEntry[]): string {
  if (agents.length === 0) {
    return 'No voice agents are wired for this group, so nothing can be dialled until an operator re-runs /add-elevenlabs-calls.';
  }
  const lines = agents.map((agent) => {
    const from = agent.phone_number ? `dials from ${agent.phone_number}` : 'no phone number configured';
    const variables = requiredVariables(agent);
    const needs = variables.length ? `requires: ${variables.join(', ')}` : 'takes no variables';
    return `  • "${agent.name}" (${agent.agent_id}) — ${from} — ${needs}`;
  });
  return `Agents available to this group:\n${lines.join('\n')}`;
}
