/**
 * Which `{{placeholders}}` an ElevenLabs agent expects, read straight off its
 * agent config.
 *
 * Pure on purpose: the MCP server snapshots these into its tool descriptions and
 * the host-side `discover.ts` writes them into config.json at install time. One
 * extractor means the two can never disagree about what a call requires.
 *
 * `system__*` are filled in by the platform and `secret__*` resolve from
 * ElevenLabs' own secret store. Sending either from here is ignored at best, so
 * both are dropped rather than reported as something the caller must supply.
 */
export type VariableSource = 'system_prompt' | 'first_message';

export interface DynamicVariable {
  name: string;
  used_in: VariableSource[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const RESERVED_PREFIXES = ['system__', 'secret__'];

function textAt(root: unknown, ...path: string[]): string {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return '';
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' ? node : '';
}

function scan(text: string, source: VariableSource, found: Map<string, Set<VariableSource>>): void {
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const sources = found.get(name) ?? new Set<VariableSource>();
    sources.add(source);
    found.set(name, sources);
  }
}

export function extractDynamicVariables(agentConfig: unknown): DynamicVariable[] {
  const found = new Map<string, Set<VariableSource>>();
  scan(textAt(agentConfig, 'conversation_config', 'agent', 'prompt', 'prompt'), 'system_prompt', found);
  scan(textAt(agentConfig, 'conversation_config', 'agent', 'first_message'), 'first_message', found);
  return [...found].map(([name, sources]) => ({ name, used_in: [...sources] }));
}
