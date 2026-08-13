/**
 * The claim worth testing is the gating one: a capability the operator did not
 * enable produces no tool, so it is absent from `tools/list` rather than
 * present-and-refusing. Everything else here guards the places a wrong answer
 * reaches a real phone — the allowlist, the required-variable check, and the
 * choice of outbound endpoint — plus the poll decision, whose two failure modes
 * are a call that never reports and a series that never ends.
 *
 * Hermetic at the external edge: the recording client stands in for `fetch`, and
 * the assertions that matter reject before it is ever reached.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ElevenLabsClient, type ConversationDetail, type ConversationListItem, type PhoneProvider } from './api.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { decidePoll } from './poll.js';
import { parseProcEnviron } from './proxy.js';
import { buildTools } from './tools/index.js';
import { extractDynamicVariables } from './variables.js';

class RecordingClient extends ElevenLabsClient {
  readonly calls: { pathname: string; body?: unknown }[] = [];
  response: unknown = { conversation_id: 'conv_1', success: true };

  protected async request<T>(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    this.calls.push({ pathname, body: init.body });
    return this.response as T;
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elevenlabs-mcp-'));
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    capabilities: ['list_agents', 'start_call', 'get_call', 'list_conversations'],
    poll: { recurrence: '*/2 * * * *', deadline_minutes: 30 },
    agents: [
      {
        agent_id: 'agent_01xyz',
        name: 'Reception',
        phone_number_id: 'phnum_1',
        phone_number: '+972500000000',
        provider: 'twilio',
        dynamic_variables: [
          { name: 'customer_name', used_in: ['first_message'] },
          { name: 'order_id', used_in: ['system_prompt'] },
        ],
      },
    ],
    ...overrides,
  };
}

function toolNames(config: Config): string[] {
  return buildTools(config, new RecordingClient()).map((t) => t.tool.name);
}

async function callTool(config: Config, name: string, args: Record<string, unknown>, client = new RecordingClient()) {
  const tool = buildTools(config, client).find((t) => t.tool.name === name);
  if (!tool) throw new Error(`${name} was not built`);
  const result = await tool.handler(args);
  const first = result.content[0] as { text: string };
  return { client, isError: result.isError === true, text: first.text };
}

describe('capability gating', () => {
  it('omits start_call entirely when it is not enabled', () => {
    const names = toolNames(makeConfig({ capabilities: ['list_agents', 'get_call', 'list_conversations'] }));
    expect(names).not.toContain('start_call');
    expect(names.sort()).toEqual(['get_call', 'list_agents', 'list_conversations']);
  });

  it('builds every tool when all four are enabled', () => {
    expect(toolNames(makeConfig()).sort()).toEqual(['get_call', 'list_agents', 'list_conversations', 'start_call']);
  });

  it('builds nothing when no capability is enabled', () => {
    expect(toolNames(makeConfig({ capabilities: [] }))).toEqual([]);
  });

  it("snapshots the group's agents and their variables into the start_call description", () => {
    const [description] = buildTools(makeConfig({ capabilities: ['start_call'] }), new RecordingClient()).map(
      (t) => t.tool.description,
    );
    expect(description).toContain('"Reception" (agent_01xyz)');
    expect(description).toContain('+972500000000');
    expect(description).toContain('requires: customer_name, order_id');
  });
});

describe('start_call refuses before it dials', () => {
  it('rejects an agent that is not in the allowlist, with no fetch', async () => {
    const { client, isError, text } = await callTool(makeConfig(), 'start_call', {
      agent: 'agent_09other',
      to_number: '+972500000001',
      dynamic_variables: { customer_name: 'Dana', order_id: '7' },
    });
    expect(isError).toBe(true);
    expect(text).toContain('agent_09other');
    expect(client.calls).toEqual([]);
  });

  it('names every missing dynamic variable, with no fetch', async () => {
    const { client, isError, text } = await callTool(makeConfig(), 'start_call', {
      agent: 'Reception',
      to_number: '+972500000001',
      dynamic_variables: { customer_name: 'Dana' },
    });
    expect(isError).toBe(true);
    expect(text).toContain('order_id');
    expect(text).not.toContain('customer_name');
    expect(client.calls).toEqual([]);
  });

  it('treats a blank variable value as missing', async () => {
    const { client, isError } = await callTool(makeConfig(), 'start_call', {
      agent: 'Reception',
      to_number: '+972500000001',
      dynamic_variables: { customer_name: '   ', order_id: '7' },
    });
    expect(isError).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it('rejects a number that is not E.164, with no fetch', async () => {
    const { client, isError } = await callTool(makeConfig(), 'start_call', {
      agent: 'Reception',
      to_number: '0500000001',
      dynamic_variables: { customer_name: 'Dana', order_id: '7' },
    });
    expect(isError).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it('refuses an agent with no number to dial from, with no fetch', async () => {
    const config = makeConfig({
      agents: [{ agent_id: 'agent_01xyz', name: 'Reception', provider: 'twilio', dynamic_variables: [] }],
    });
    const { client, isError } = await callTool(config, 'start_call', {
      agent: 'Reception',
      to_number: '+972500000001',
    });
    expect(isError).toBe(true);
    expect(client.calls).toEqual([]);
  });
});

describe('start_call endpoint selection', () => {
  async function dial(provider: PhoneProvider) {
    const config = makeConfig({
      agents: [
        {
          agent_id: 'agent_01xyz',
          name: 'Reception',
          phone_number_id: 'phnum_1',
          phone_number: '+972500000000',
          provider,
          dynamic_variables: [],
        },
      ],
    });
    return callTool(config, 'start_call', { agent: 'Reception', to_number: '+972 50-000 0001' });
  }

  it('sends a twilio number to the twilio endpoint', async () => {
    const { client, isError } = await dial('twilio');
    expect(isError).toBe(false);
    expect(client.calls[0].pathname).toBe('/v1/convai/twilio/outbound-call');
  });

  it('sends a sip_trunk number to the sip-trunk endpoint', async () => {
    const { client } = await dial('sip_trunk');
    expect(client.calls[0].pathname).toBe('/v1/convai/sip-trunk/outbound-call');
  });

  it('refuses a provider with no outbound endpoint', async () => {
    const { client, isError, text } = await dial('exotel');
    expect(isError).toBe(true);
    expect(text).toContain('exotel');
    expect(client.calls).toEqual([]);
  });

  it('normalizes the dialled number and passes the variables through', async () => {
    const { client } = await dial('twilio');
    expect(client.calls[0].body).toEqual({
      agent_id: 'agent_01xyz',
      agent_phone_number_id: 'phnum_1',
      to_number: '+972500000001',
      conversation_initiation_client_data: { dynamic_variables: {} },
    });
  });

  it('returns a ready-to-run follow-up command carrying the conversation and the report destination', async () => {
    const { text } = await dial('twilio');
    const result = JSON.parse(text) as { conversation_id: string; status: string; follow_up_command: string };
    expect(result.conversation_id).toBe('conv_1');
    expect(result.status).toBe('initiated');
    expect(result.follow_up_command).toContain("--name 'el-call-conv_1'");
    expect(result.follow_up_command).toContain("--recurrence '*/2 * * * *'");
    expect(result.follow_up_command).toMatch(/--script 'bun \/app\/src\/elevenlabs-mcp\/poll\.ts conv_1 \S+'/);
  });
});

describe('list_conversations', () => {
  it('rejects an agent outside the allowlist, with no fetch', async () => {
    const { client, isError } = await callTool(makeConfig(), 'list_conversations', { agent: 'agent_09other' });
    expect(isError).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it('reads the allowlisted agent through the conversations endpoint', async () => {
    const client = new RecordingClient();
    client.response = { conversations: [{ conversation_id: 'conv_1' } as ConversationListItem] };
    const { text } = await callTool(makeConfig(), 'list_conversations', { agent: 'Reception' }, client);
    expect(client.calls[0].pathname).toBe('/v1/convai/conversations');
    expect(JSON.parse(text).conversations).toHaveLength(1);
  });
});

describe('extractDynamicVariables', () => {
  const agentConfig = {
    conversation_config: {
      agent: {
        first_message: 'Hi {{customer_name}}, calling about {{ order_id }}.',
        prompt: {
          prompt:
            'You speak to {{customer_name}} about {{order_id}}. Caller is {{system__caller_id}}, key {{secret__api}}.',
        },
      },
    },
  };

  it('finds placeholders in both the prompt and the first message', () => {
    expect(
      extractDynamicVariables(agentConfig)
        .map((v) => v.name)
        .sort(),
    ).toEqual(['customer_name', 'order_id']);
  });

  it('dedupes across the two and records where each one is used', () => {
    const variables = extractDynamicVariables(agentConfig);
    expect(variables).toHaveLength(2);
    expect(variables.find((v) => v.name === 'customer_name')!.used_in.sort()).toEqual([
      'first_message',
      'system_prompt',
    ]);
  });

  it('excludes system__ and secret__ placeholders', () => {
    const names = extractDynamicVariables(agentConfig).map((v) => v.name);
    expect(names).not.toContain('system__caller_id');
    expect(names).not.toContain('secret__api');
  });

  it('returns nothing for an agent config it cannot read', () => {
    expect(extractDynamicVariables({})).toEqual([]);
    expect(extractDynamicVariables(null)).toEqual([]);
  });
});

describe('poll decision', () => {
  const deadline = '2026-01-01T12:00:00.000Z';
  const during = new Date('2026-01-01T11:30:00.000Z');
  const after = new Date('2026-01-01T12:30:00.000Z');
  const conv = (status: string): ConversationDetail => ({
    conversation_id: 'conv_1',
    status,
    transcript: [{ role: 'agent', message: 'Hello' }],
    analysis: { transcript_summary: 'Confirmed the order.' },
  });

  it('does not wake the agent while the call is running', () => {
    for (const status of ['initiated', 'in-progress', 'processing']) {
      expect(decidePoll(conv(status), deadline, during)).toEqual({ wakeAgent: false });
    }
  });

  it('wakes the agent with the report once the call is done or failed', () => {
    for (const status of ['done', 'failed']) {
      const decision = decidePoll(conv(status), deadline, during);
      expect(decision.wakeAgent).toBe(true);
      expect(decision.data).toMatchObject({ status, summary: 'Confirmed the order.' });
      expect(decision.data).not.toHaveProperty('timed_out');
    }
  });

  it('wakes the agent with timed_out once the deadline has passed', () => {
    const decision = decidePoll(conv('in-progress'), deadline, after);
    expect(decision.wakeAgent).toBe(true);
    expect(decision.data).toMatchObject({ timed_out: true, status: 'in-progress' });
  });

  it('keeps polling a conversation that has no status yet', () => {
    expect(decidePoll({ conversation_id: 'conv_1' }, deadline, during)).toEqual({ wakeAgent: false });
  });
});

describe('config.json', () => {
  it('throws ConfigError when the file is missing, which is what makes the server exit quietly', () => {
    expect(() => loadConfig(tmpdir())).toThrow(ConfigError);
  });

  it('throws ConfigError on malformed JSON', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'config.json'), '{nope');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('rejects a misspelled capability rather than silently dropping the tool', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ capabilities: ['start_calls'] }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('fills in the poll defaults and tolerates an agent with no variables', () => {
    const dir = tmpdir();
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ capabilities: ['get_call'], agents: [{ agent_id: 'agent_01xyz' }] }),
    );
    const config = loadConfig(dir);
    expect(config.poll).toEqual({ recurrence: '*/2 * * * *', deadline_minutes: 30 });
    expect(config.agents[0]).toEqual({ agent_id: 'agent_01xyz', name: 'agent_01xyz', dynamic_variables: [] });
  });
});

describe('proxy recovery', () => {
  it('round-trips the NUL-separated environ blob', () => {
    const blob = 'HTTPS_PROXY=http://172.17.0.1:10255\0NODE_EXTRA_CA_CERTS=/etc/onecli/ca.pem\0PATH=/usr/bin\0';
    expect(parseProcEnviron(blob)).toEqual({
      HTTPS_PROXY: 'http://172.17.0.1:10255',
      NODE_EXTRA_CA_CERTS: '/etc/onecli/ca.pem',
      PATH: '/usr/bin',
    });
  });

  it('keeps everything after the first = and skips entries without one', () => {
    expect(parseProcEnviron('A=b=c\0BROKEN\0=novalue\0')).toEqual({ A: 'b=c' });
  });
});
