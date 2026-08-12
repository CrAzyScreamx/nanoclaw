#!/usr/bin/env bun
/**
 * Install-time discovery, run on the host by `/add-elevenlabs-calls`:
 *
 *   ELEVENLABS_API_KEY=… bun container/agent-runner/src/elevenlabs-mcp/discover.ts [--json]
 *
 * Prints the account's voice agents, the number each one dials from, and the
 * `{{placeholders}}` each one expects, then the config.json fragment for the
 * groups the operator picks.
 *
 * This is the one place a raw key is used, held in the shell for that phase and
 * never written into the repo or passed to a container — the same shape as
 * `add-homeassistant/connect.md`. Everything after install goes through the
 * OneCLI gateway.
 */
import { ElevenLabsClient, type AgentDetail, type PhoneNumber } from './api.js';
import { CAPABILITIES, DEFAULT_POLL, type AgentEntry } from './config.js';
import { extractDynamicVariables } from './variables.js';

export function assemble(details: AgentDetail[], numbers: PhoneNumber[]): AgentEntry[] {
  return details.map((detail) => {
    const number = numbers.find((candidate) => candidate.assigned_agent?.agent_id === detail.agent_id);
    return {
      agent_id: detail.agent_id,
      name: detail.name ?? detail.agent_id,
      ...(number
        ? { phone_number_id: number.phone_number_id, phone_number: number.phone_number, provider: number.provider }
        : {}),
      dynamic_variables: extractDynamicVariables(detail),
    };
  });
}

function renderTable(entries: AgentEntry[]): string {
  const rows = entries.map((entry) => [
    entry.name,
    entry.agent_id,
    entry.phone_number ? `${entry.phone_number} (${entry.provider ?? 'unknown'})` : '— no number assigned —',
    entry.dynamic_variables.map((variable) => variable.name).join(', ') || '—',
  ]);
  const header = ['AGENT', 'AGENT ID', 'DIALS FROM', 'DYNAMIC VARIABLES'];
  const widths = header.map((_, column) => Math.max(header[column].length, ...rows.map((row) => row[column].length)));
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    console.error('Set ELEVENLABS_API_KEY (or XI_API_KEY) for this command only — it is not stored anywhere.');
    process.exit(1);
  }

  const jsonOnly = process.argv.includes('--json');
  const client = new ElevenLabsClient({ apiKey });
  const [agents, numbers] = await Promise.all([client.listAgents(), client.listPhoneNumbers()]);
  // The list endpoint carries no prompt, so the variables need one fetch each.
  const details = await Promise.all(agents.map((agent) => client.getAgent(agent.agent_id)));
  const entries = assemble(details, numbers);

  if (!jsonOnly) {
    console.log(renderTable(entries));
    const unassigned = numbers.filter((number) => !number.assigned_agent?.agent_id);
    if (unassigned.length) {
      console.log(
        `\nNumbers with no agent assigned: ${unassigned.map((n) => n.phone_number ?? n.phone_number_id).join(', ')}`,
      );
    }
    console.log('\nconfig.json fragment (keep only the agents this group may dial):');
  }
  console.log(JSON.stringify({ capabilities: [...CAPABILITIES], poll: DEFAULT_POLL, agents: entries }, null, 2));
}

if (import.meta.main) {
  await main();
}
