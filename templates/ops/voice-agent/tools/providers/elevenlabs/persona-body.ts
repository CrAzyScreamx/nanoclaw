/**
 * persona-body.ts — building the write body for an ElevenLabs agent, and
 * refusing the credentials that must never travel inside one.
 *
 * Split out of provider.ts so the mapper stays a mapper: this file owns one
 * concern, turning a neutral `PersonaInput` into `conversation_config`, and the
 * refusal that guards it.
 *
 * No credential is read or written here — the refusal below is the point.
 */

import { ExitCode, VoiceToolError, type PersonaInput } from '../../lib/provider.ts';
import type { ElAgentTool, ElAgentWriteBody } from './types.ts';

const SETUP_REFERENCE = 'skills/voice-line/references/set-up-the-line.md';

/** The system tool that lets a persona hang up when its conditions are met. */
export const END_CALL_TOOL: ElAgentTool = { type: 'system', name: 'end_call' };

export function isEndCallTool(tool: ElAgentTool | null | undefined): boolean {
  return tool?.name === 'end_call' || tool?.type === 'end_call';
}

/**
 * Credential-shaped input the agent must never write into an ElevenLabs agent
 * body. See `refuseTrunkConfig` for why this is structural, not squeamishness.
 */
const FORBIDDEN_KEYS = [
  'inbound_trunk_config', 'outbound_trunk_config', 'username', 'password', 'credentials',
  'auth_token', 'authtoken', 'api_key', 'apikey', 'secret', 'token',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Refuses trunk / digest credentials in persona input.
 *
 * The reason is structural: the OneCLI vault injects headers on outbound HTTPS,
 * while these values travel inside a JSON body to ElevenLabs — so they cannot be
 * vault-backed, and anywhere else in the container means plaintext.
 */
export function refuseTrunkConfig(input: unknown, path = 'input'): void {
  const record = asRecord(input);
  if (!record) return;
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw new VoiceToolError(
        `Refusing to write "${key}" (at ${path}.${key}) into an ElevenLabs agent. Trunk configuration ` +
          'and digest username/password are set in the ElevenLabs dashboard, never by the agent: the ' +
          'OneCLI vault injects headers on outbound HTTPS, while these values ride inside a JSON body, ' +
          'so they cannot be vault-backed — and anywhere else in this container means plaintext.',
        { code: 'credential_in_body', exitCode: ExitCode.USAGE, hint: SETUP_REFERENCE },
      );
    }
    if (value && typeof value === 'object') refuseTrunkConfig(value, `${path}.${key}`);
  }
}

/**
 * `PersonaInput` → `conversation_config`. Only the fields actually supplied are
 * sent, so an update never blanks something it was not asked to change.
 *
 * @param currentTools the persona's existing tools, required on update when the
 *   `end_call` toggle is part of the patch: the new array is derived from them,
 *   so adding the tool cannot wipe the others and removing it is expressible.
 */
export function buildAgentBody(
  input: Partial<PersonaInput>,
  forCreate: boolean,
  currentTools?: ElAgentTool[],
): ElAgentWriteBody {
  refuseTrunkConfig(input);

  const agent: Record<string, unknown> = {};
  const prompt: Record<string, unknown> = {};
  if (input.prompt !== undefined) prompt.prompt = input.prompt;
  // A persona with no `end_call` system tool runs until the callee hangs up, so
  // it is included on create unless the caller explicitly opts out. On update the
  // toggle is read-modify-write: sending a bare `{ tools: [end_call] }` patch
  // would replace the whole array.
  if (forCreate) {
    if (input.endCallTool !== false) prompt.tools = [END_CALL_TOOL];
  } else if (input.endCallTool !== undefined) {
    const kept = (currentTools ?? []).filter((tool) => !isEndCallTool(tool));
    prompt.tools = input.endCallTool ? [...kept, END_CALL_TOOL] : kept;
  }
  if (Object.keys(prompt).length > 0) agent.prompt = prompt;
  if (input.firstMessage !== undefined) agent.first_message = input.firstMessage;
  if (input.language !== undefined) agent.language = input.language;

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agent).length > 0) conversationConfig.agent = agent;
  if (input.voiceId !== undefined) conversationConfig.tts = { voice_id: input.voiceId };

  const body: ElAgentWriteBody = {};
  if (input.name !== undefined) body.name = input.name;
  if (Object.keys(conversationConfig).length > 0) {
    body.conversation_config = conversationConfig as ElAgentWriteBody['conversation_config'];
  }
  return body;
}
