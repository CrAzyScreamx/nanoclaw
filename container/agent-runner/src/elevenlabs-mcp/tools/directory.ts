/**
 * Reading the account without dialling anything: who this group may call, and
 * what it has called before.
 *
 * Both tools stay inside the allowlist. The account may hold agents and numbers
 * this group was never given, and a directory listing is not the place to
 * discover them.
 */
import { extractDynamicVariables } from '../variables.js';
import type { ElevenLabsApi } from '../api.js';
import { findAgent, type AgentEntry, type Config } from '../config.js';
import { agentRefs, agentSnapshot, fail, guard, json, num, str, type ToolDefinition } from './describe.js';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 30;

async function liveVariables(api: ElevenLabsApi, agent: AgentEntry): Promise<Record<string, unknown>> {
  const configured = agent.dynamic_variables.map((variable) => variable.name);
  try {
    const detail = await api.getAgent(agent.agent_id);
    const live = extractDynamicVariables(detail);
    return {
      name: detail.name ?? agent.name,
      dynamic_variables: live,
      // The description snapshot is written at install time; an edit to the
      // agent's prompt since then shows up here and nowhere else.
      added_since_install: live.map((variable) => variable.name).filter((name) => !configured.includes(name)),
    };
  } catch (e) {
    return { name: agent.name, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listAgentsTool(config: Config, api: ElevenLabsApi): ToolDefinition {
  return {
    tool: {
      name: 'list_agents',
      description:
        "Re-read this group's voice agents from ElevenLabs: their current names and the variables their prompts ask for right now. " +
        'Read-only, dials nothing. Use it when a call is refused for a variable you did not expect, or when someone has just edited an agent. ' +
        `${agentSnapshot(config.agents)}`,
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () =>
      guard(async () =>
        json(
          await Promise.all(
            config.agents.map(async (agent) => ({
              agent_id: agent.agent_id,
              phone_number: agent.phone_number ?? null,
              provider: agent.provider ?? null,
              configured_variables: agent.dynamic_variables,
              ...(await liveVariables(api, agent)),
            })),
          ),
        ),
      ),
  };
}

export function listConversationsTool(config: Config, api: ElevenLabsApi): ToolDefinition {
  return {
    tool: {
      name: 'list_conversations',
      description:
        "List past calls made by one of this group's agents, most recent first. Use get_call for the full transcript of any one of them. " +
        `${agentSnapshot(config.agents)}`,
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Whose calls to list — a name or an agent_id from the list above.' },
          limit: {
            type: 'number',
            description: `How many to return (default ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}).`,
          },
          include_summaries: {
            type: 'boolean',
            description: "Include each call's summary. Slower, and much more to read.",
          },
        },
        required: ['agent'],
      },
    },
    handler: (args) =>
      guard(async () => {
        const ref = str(args, 'agent');
        if (!ref) return fail(`Whose calls? Available: ${agentRefs(config.agents)}`);
        const agent = findAgent(config.agents, ref);
        if (!agent) return fail(`"${ref}" is not an agent this group may read. Available: ${agentRefs(config.agents)}`);

        const limit = Math.min(num(args, 'limit') ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const conversations = await api.listConversations({
          agent_id: agent.agent_id,
          page_size: limit,
          summary_mode: args.include_summaries === true ? 'include' : 'exclude',
        });
        return json({ agent: agent.name, agent_id: agent.agent_id, conversations });
      }),
  };
}
