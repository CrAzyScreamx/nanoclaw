#!/usr/bin/env bun
/**
 * `ha-mcp` — a stdio MCP server exposing one agent group's Home Assistant
 * capabilities as tools.
 *
 * Launched per group by the agent runner from `container.json`:
 *
 *   command: "bun", args: ["/app/src/ha-mcp/server.ts"]
 *
 * `/app/src` is the shared read-only mount of `container/agent-runner/src`
 * (`src/container-runner.ts`), so this file is live in every container without
 * an image rebuild — but it only *runs* where `/add-homeassistant` registered
 * it, which is what makes group selection real rather than advisory.
 *
 * Everything variable comes from `/workspace/agent/home-assistant/`, read once
 * at startup. Changing what a group can do means editing those files and
 * restarting the group, not editing this server.
 *
 * A group with no config exits 0 with a log line rather than crashing: a
 * leftover registration on a de-configured group should look like "no tools",
 * not like a broken container.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { CONFIG_DIR, ConfigError, loadConnection, loadServices } from './config.js';
import { HomeAssistant } from './ha.js';
import { buildTools, type ToolDefinition } from './tools.js';

function log(msg: string): void {
  // stderr: stdout is the MCP transport and anything written there corrupts it.
  console.error(`[ha-mcp] ${msg}`);
}

async function main(): Promise<void> {
  let tools: ToolDefinition[];
  try {
    const connection = loadConnection(CONFIG_DIR);
    const services = loadServices(CONFIG_DIR);
    const ha = new HomeAssistant(connection);
    tools = buildTools(services, ha, CONFIG_DIR);
    log(`config: ${connection.url} (auth=${connection.auth}), ${tools.length} tools enabled`);
    // Logged unconditionally: "gateway mode but connecting directly" is the
    // one misconfiguration that otherwise only shows up as a 401 much later.
    log(`network: ${ha.proxy.note}`);
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`not enabled for this group: ${e.message}`);
      return;
    }
    throw e;
  }

  const byName = new Map(tools.map((t) => [t.tool.name, t]));
  const server = new Server({ name: 'homeassistant', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Error: no such tool "${name}". Enabled here: ${[...byName.keys()].join(', ') || '(none)'}` }],
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
