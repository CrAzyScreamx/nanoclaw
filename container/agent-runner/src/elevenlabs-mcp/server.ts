#!/usr/bin/env bun
/**
 * `elevenlabs` — a stdio MCP server exposing one agent group's outbound-calling
 * tools.
 *
 * Launched per group by the agent runner from `container.json`:
 *
 *   command: "bun", args: ["/app/src/elevenlabs-mcp/server.ts"]
 *
 * `/app/src` is the shared read-only mount of `container/agent-runner/src`
 * (`src/container-runner.ts`), so this file is live in every container without
 * an image rebuild — but it only *runs* where `/add-elevenlabs-calls` registered
 * it, which is what makes group selection real rather than advisory.
 *
 * Everything variable comes from `/workspace/agent/elevenlabs/config.json`, read
 * once at startup. Changing which agents a group may dial means editing that
 * file and restarting the group, not editing this server.
 *
 * A group with no config exits 0 with a log line rather than crashing: a
 * leftover registration on a de-configured group should look like "no tools",
 * not like a broken container.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { ElevenLabsClient } from './api.js';
import { CONFIG_DIR, ConfigError, loadConfig } from './config.js';
import { buildTools, type ToolDefinition } from './tools/index.js';

function log(msg: string): void {
  // stderr: stdout is the MCP transport and anything written there corrupts it.
  console.error(`[elevenlabs-mcp] ${msg}`);
}

async function main(): Promise<void> {
  let tools: ToolDefinition[];
  try {
    const config = loadConfig(CONFIG_DIR);
    const api = new ElevenLabsClient();
    tools = buildTools(config, api);
    log(`config: ${config.agents.length} agents, ${tools.length} tools enabled`);
    // Logged unconditionally: "connecting directly" is the one misconfiguration
    // that otherwise only shows up as a 401 much later.
    log(`network: ${api.proxy.note}`);
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`not enabled for this group: ${e.message}`);
      return;
    }
    throw e;
  }

  const byName = new Map(tools.map((t) => [t.tool.name, t]));
  const server = new Server({ name: 'elevenlabs', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: no such tool "${name}". Enabled here: ${[...byName.keys()].join(', ') || '(none)'}`,
          },
        ],
        isError: true,
      };
    }
    return tool.handler(args ?? {});
  });

  await server.connect(new StdioServerTransport());
  log(`ready: ${[...byName.keys()].join(', ') || '(none)'}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
