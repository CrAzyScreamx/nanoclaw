#!/usr/bin/env bun
/**
 * Gate script for the `el-call-<conversation_id>` task series that reports a
 * finished call:
 *
 *   bun /app/src/elevenlabs-mcp/poll.ts <conversation_id> <deadline_iso>
 *
 * The runner executes this under bash with `env: process.env`
 * (`scheduling/task-script.ts`), so it inherits the container's proxy variables
 * and reaches ElevenLabs through the same gateway with no key of its own — this
 * is the one entry point here that does *not* need `proxy.ts`.
 *
 * The last stdout line must be one JSON object with a boolean `wakeAgent`;
 * anything else is treated as a broken script. `wakeAgent: false` costs zero
 * tokens, which is why the series may run every two minutes at all.
 */
import { ElevenLabsClient, summarizeConversation, type ConversationDetail } from './api.js';

export interface PollDecision {
  wakeAgent: boolean;
  data?: Record<string, unknown>;
}

const LIVE_STATUSES = new Set(['initiated', 'in-progress', 'in_progress', 'processing']);

/**
 * An unrecognized status is treated as terminal: waking on a status we do not
 * know costs one turn, whereas treating it as live would sit on the report until
 * the deadline. A missing status is the exception — a conversation record can be
 * that thin in the seconds after the dial.
 */
export function isLive(status: string): boolean {
  return status === '' || LIVE_STATUSES.has(status);
}

/** An unparseable deadline counts as passed, so a malformed series still ends. */
export function pastDeadline(deadlineIso: string, now: Date): boolean {
  const deadline = Date.parse(deadlineIso);
  return !Number.isFinite(deadline) || now.getTime() >= deadline;
}

export function decidePoll(conv: ConversationDetail, deadlineIso: string, now: Date = new Date()): PollDecision {
  const status = typeof conv.status === 'string' ? conv.status.trim() : '';
  if (!isLive(status)) return { wakeAgent: true, data: { ...summarizeConversation(conv) } };
  if (pastDeadline(deadlineIso, now))
    return { wakeAgent: true, data: { ...summarizeConversation(conv), timed_out: true } };
  return { wakeAgent: false };
}

function emit(decision: PollDecision): void {
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

async function main(): Promise<void> {
  const [conversationId, deadlineIso] = process.argv.slice(2);
  if (!conversationId || !deadlineIso) {
    console.error('[elevenlabs-poll] usage: poll.ts <conversation_id> <deadline_iso>');
    emit({ wakeAgent: false });
    return;
  }

  try {
    emit(decidePoll(await new ElevenLabsClient().getConversation(conversationId), deadlineIso));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[elevenlabs-poll] ${message}`);
    // A transient failure must not wake the agent with nothing to say, but once
    // the deadline has passed a call that can no longer be read is over as far
    // as this series is concerned.
    emit(
      pastDeadline(deadlineIso, new Date())
        ? {
            wakeAgent: true,
            data: { conversation_id: conversationId, status: 'unknown', timed_out: true, error: message },
          }
        : { wakeAgent: false },
    );
  }
}

if (import.meta.main) {
  await main();
}
