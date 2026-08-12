/**
 * Capability gating. This is where "only what the operator enabled" happens: a
 * capability that is not in config.json produces no tool at all, so it is absent
 * from `tools/list` rather than present-and-refusing.
 *
 * That is the useful property. A group given read-only access to call history
 * cannot be talked into dialling, and does not spend context reading about a
 * tool it may not use.
 *
 * It is not a security boundary — see the skill's caveats.md.
 */
import type { ElevenLabsApi } from '../api.js';
import type { Capability, Config } from '../config.js';
import { getCallTool, startCallTool } from './calls.js';
import { listAgentsTool, listConversationsTool } from './directory.js';
import type { ToolDefinition } from './describe.js';

export type { ToolDefinition };

export function buildTools(config: Config, api: ElevenLabsApi): ToolDefinition[] {
  const has = (capability: Capability) => config.capabilities.includes(capability);
  const tools: ToolDefinition[] = [];
  if (has('list_agents')) tools.push(listAgentsTool(config, api));
  if (has('start_call')) tools.push(startCallTool(config, api));
  if (has('get_call')) tools.push(getCallTool(api));
  if (has('list_conversations')) tools.push(listConversationsTool(config, api));
  return tools;
}
