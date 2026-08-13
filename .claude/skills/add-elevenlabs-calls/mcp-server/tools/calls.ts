/**
 * Placing a call and reading one back.
 *
 * Everything `start_call` can check is checked before the fetch. A dial that
 * goes out with an unsubstituted `{{customer_name}}` reaches a real person and
 * cannot be recalled, so the allowlist and the variable list are hard gates, not
 * warnings appended to a result.
 */
import { summarizeConversation, type ElevenLabsApi } from '../api.js';
import { findAgent, type Config } from '../config.js';
import {
  agentRefs,
  agentSnapshot,
  fail,
  guard,
  json,
  record,
  requiredVariables,
  str,
  type ToolDefinition,
} from './describe.js';

const E164 = /^\+[1-9]\d{6,14}$/;

/** Single-quote for bash, so a report_to containing a quote cannot break the line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function followUpCommand(
  conversationId: string,
  deadlineIso: string,
  recurrence: string,
  reportTo?: string,
): string {
  const destination = reportTo ? `to ${reportTo}` : 'to whoever asked for this call';
  const prompt =
    `The ElevenLabs call (conversation ${conversationId}) has finished. The transcript and analysis are in the script data. ` +
    `Summarize what happened and send it ${destination} with send_message. Then cancel this task series.`;
  return [
    'ncl tasks create \\',
    `  --name ${shellQuote(`el-call-${conversationId}`)} \\`,
    `  --recurrence ${shellQuote(recurrence)} \\`,
    `  --script ${shellQuote(`bun /app/src/elevenlabs-mcp/poll.ts ${conversationId} ${deadlineIso}`)} \\`,
    `  --prompt ${shellQuote(prompt)}`,
  ].join('\n');
}

export function startCallTool(config: Config, api: ElevenLabsApi): ToolDefinition {
  return {
    tool: {
      name: 'start_call',
      description:
        "Place an outbound phone call: ElevenLabs dials the number and one of this group's voice agents speaks to whoever answers. " +
        'This rings a real phone and cannot be taken back — confirm the number, the agent and every variable value with the person who asked, for every call. ' +
        `${agentSnapshot(config.agents)}\n\n` +
        'Returns immediately with a conversation_id and a follow_up_command. Run that command verbatim (Bash) to be woken when the call ends; do not poll by hand and never re-dial because a result is slow.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Which voice agent speaks — a name or an agent_id from the list above.',
          },
          to_number: {
            type: 'string',
            description: 'The number to dial, E.164 with country code (e.g. +972501234567).',
          },
          dynamic_variables: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'A value for every variable the chosen agent requires. Ask for anything you do not have rather than guessing.',
          },
          phone_number_id: {
            type: 'string',
            description: 'Dial from a different number than the one the agent is wired to.',
          },
          report_to: {
            type: 'string',
            description: 'Destination the call summary should be sent to; substituted into follow_up_command.',
          },
        },
        required: ['agent', 'to_number'],
      },
    },
    handler: (args) =>
      guard(async () => {
        const ref = str(args, 'agent');
        if (!ref) return fail(`Which agent should speak? Available: ${agentRefs(config.agents)}`);
        const agent = findAgent(config.agents, ref);
        if (!agent) return fail(`"${ref}" is not an agent this group may dial. Available: ${agentRefs(config.agents)}`);

        const raw = str(args, 'to_number') ?? '';
        const toNumber = raw.replace(/[\s()\-.]/g, '');
        if (!E164.test(toNumber)) {
          return fail(
            `"${raw}" is not an E.164 number. Give the full international form, starting with + and a country code.`,
          );
        }

        const phoneNumberId = str(args, 'phone_number_id') ?? agent.phone_number_id;
        if (!phoneNumberId) {
          return fail(
            `"${agent.name}" has no phone number to dial from. An operator has to re-run /add-elevenlabs-calls, or pass phone_number_id.`,
          );
        }

        const provided = record(args, 'dynamic_variables');
        const missing = requiredVariables(agent).filter((name) => !String(provided[name] ?? '').trim());
        if (missing.length) {
          return fail(
            `"${agent.name}" needs a value for ${missing.join(', ')} before it can dial. ` +
              'Those go into what it says out loud, so ask for them rather than sending a placeholder.',
          );
        }
        const dynamicVariables = Object.fromEntries(
          Object.entries(provided).map(([key, value]) => [key, String(value)]),
        );

        const result = await api.outboundCall(agent.provider, {
          agent_id: agent.agent_id,
          agent_phone_number_id: phoneNumberId,
          to_number: toNumber,
          conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
        });

        if (!result.conversation_id) {
          return fail(
            `ElevenLabs did not start the call: ${result.message ?? 'the response carried no conversation_id'}`,
          );
        }

        const deadline = new Date(Date.now() + config.poll.deadline_minutes * 60_000).toISOString();
        return json({
          conversation_id: result.conversation_id,
          status: result.success === false ? 'failed' : 'initiated',
          ...(result.message ? { message: result.message } : {}),
          dialled: toNumber,
          follow_up_command: followUpCommand(
            result.conversation_id,
            deadline,
            config.poll.recurrence,
            str(args, 'report_to'),
          ),
        });
      }),
  };
}

export function getCallTool(api: ElevenLabsApi): ToolDefinition {
  return {
    tool: {
      name: 'get_call',
      description:
        'Read one call by conversation_id: status, duration, summary, collected data, and the transcript so far. Returns at once — ' +
        'while status is initiated, in-progress or processing the call is still running and there is nothing final to report yet. ' +
        'done means it finished, failed means it never connected or was cut off.',
      inputSchema: {
        type: 'object',
        properties: { conversation_id: { type: 'string', description: 'The conversation_id start_call returned.' } },
        required: ['conversation_id'],
      },
    },
    handler: (args) =>
      guard(async () => {
        const conversationId = str(args, 'conversation_id');
        if (!conversationId) return fail('conversation_id is required.');
        return json(summarizeConversation(await api.getConversation(conversationId)));
      }),
  };
}
