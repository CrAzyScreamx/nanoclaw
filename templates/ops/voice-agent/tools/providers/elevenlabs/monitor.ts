/**
 * monitor.ts — the ElevenLabs conversation control channel.
 *
 *   wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor
 *
 * The channel takes JSON commands. Only `end_call` is implemented here; the
 * other two documented command shapes are recorded for reference and are
 * deliberately NOT wired up, because neither has been exercised through this
 * gateway either:
 *
 *   { "command_type": "end_call" }
 *   { "command_type": "transfer_to_number", "number": "+15551234567" }
 *   { "command_type": "enable_human_takeover" }
 *
 * No header is set on the socket. The OneCLI gateway injects `xi-api-key` by
 * destination host, exactly as it does for REST — this file reads no
 * credential and holds none.
 *
 * Access requirements (from the ElevenLabs docs): an enterprise plan, an API
 * key with the *ElevenAgents* scope set to *Write*, and the EDITOR role on the
 * workspace (a member role in workspace settings, not a key scope).
 */

import { VoiceToolError, ExitCode } from '../../lib/provider.ts';

const MONITOR_HINT = 'skills/voice-line/references/ending-a-call.md';

const DEFAULT_UNAVAILABLE_REASON =
  'the monitor WebSocket is unverified through the OneCLI proxy; it also requires an ' +
  'ElevenLabs enterprise plan and an API key with ElevenAgents set to Write';

/** Opt-in only, and only after the upgrade has actually been observed to work. */
const ENABLE_ENV = 'VOICE_LINE_ENABLE_MONITOR';

function monitorUrl(conversationId: string): string {
  return `wss://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/monitor`;
}

/**
 * Whether this install may use the monitor channel as a hang-up strategy.
 *
 * Defaults to unavailable and stays that way until an operator who has watched
 * the upgrade succeed sets VOICE_LINE_ENABLE_MONITOR=1 in the container
 * environment. This is a capability switch, never a credential.
 */
export function monitorAvailability(): { available: boolean; reason: string | null } {
  const flag = (process.env[ENABLE_ENV] ?? '').trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes';
  if (!enabled) return { available: false, reason: DEFAULT_UNAVAILABLE_REASON };
  return { available: true, reason: null };
}

function monitorFailure(detail: string): VoiceToolError {
  return new VoiceToolError(
    `Could not end the call over the ElevenLabs monitor channel: ${detail}. ` +
      'The two likely causes are (1) the account is not on an enterprise plan, or the key in the ' +
      'OneCLI vault has ElevenAgents below Write, or the account lacks the EDITOR workspace ' +
      'role, and (2) the OneCLI ' +
      'egress proxy did not pass the WebSocket upgrade through to api.elevenlabs.io. ' +
      'The always-available fallback is the `end_call` system tool on the persona.',
    { code: 'monitor_unavailable', exitCode: ExitCode.UNSUPPORTED, hint: MONITOR_HINT },
  );
}

/**
 * Sends `{"command_type":"end_call"}` on the conversation's monitor channel.
 *
 * UNVERIFIED: the WebSocket upgrade to wss://api.elevenlabs.io must traverse the
 * OneCLI MITM proxy, and Bun exposes no per-connection proxy/CA option for
 * WebSocket the way fetch does. This has NOT been confirmed against a live
 * gateway; see plan Verification step 7 (monitor). If the upgrade does not
 * survive the proxy, this path reports unavailable with the reason rather than
 * failing obscurely — `monitorAvailability()` is false by default for exactly
 * that reason, and callers must check it before calling this function.
 */
export async function monitorEndCall(conversationId: string, timeoutMs = 15000): Promise<void> {
  if (!conversationId) {
    throw new VoiceToolError('monitorEndCall needs a conversation id.', {
      code: 'usage',
      exitCode: ExitCode.USAGE,
      hint: MONITOR_HINT,
    });
  }

  const url = monitorUrl(conversationId);

  await new Promise<void>((resolve, reject) => {
    let socket: WebSocket;
    try {
      // No headers, no per-connection TLS config: the gateway owns both.
      socket = new WebSocket(url);
    } catch (err) {
      reject(monitorFailure(`the socket could not be created (${describe(err)})`));
      return;
    }

    let settled = false;
    let sent = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        sent
          ? // The command went out; nothing acknowledged it. Treat that as a
            // failure rather than reporting a hang-up that may not have happened.
            reject(monitorFailure(`no acknowledgement within ${timeoutMs}ms of sending end_call`))
          : reject(monitorFailure(`the channel did not open within ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ command_type: 'end_call' }));
        sent = true;
      } catch (err) {
        finish(() => reject(monitorFailure(`the end_call command could not be sent (${describe(err)})`)));
        return;
      }
      // Give the server a moment to act on the command and close the channel.
      // A clean close after the send is the acknowledgement we can rely on.
      setTimeout(() => finish(resolve), Math.min(2000, Math.max(250, Math.floor(timeoutMs / 5))));
    });

    socket.addEventListener('message', () => {
      // Any server frame after the command means the channel accepted it.
      if (sent) finish(resolve);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (sent) {
        finish(resolve);
        return;
      }
      const code = typeof event?.code === 'number' ? event.code : 0;
      finish(() => reject(monitorFailure(`the channel closed before the command was sent (code ${code})`)));
    });

    socket.addEventListener('error', () => {
      finish(() => reject(monitorFailure('the WebSocket upgrade failed')));
    });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
