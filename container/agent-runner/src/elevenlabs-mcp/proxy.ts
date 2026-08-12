/**
 * Recovering the OneCLI proxy settings that the MCP transport throws away.
 *
 * The container is spawned with `HTTPS_PROXY` and a `NODE_EXTRA_CA_CERTS`
 * pointing at the gateway's MITM CA — that is how an ElevenLabs request gets its
 * `xi-api-key` header injected without the key ever entering the container. But
 * a stdio MCP server is not spawned with the container's environment:
 * `StdioClientTransport` merges the server's declared `env` over
 * `getDefaultEnvironment()`, whose allowlist is exactly
 * `HOME, LOGNAME, PATH, SHELL, TERM, USER`
 * (`@modelcontextprotocol/sdk/dist/esm/client/stdio.js`). Every proxy variable
 * is dropped on the floor.
 *
 * So a server that just calls `fetch` connects directly, nothing injects a key,
 * and ElevenLabs answers 401 — with no hint that a proxy was ever involved.
 * That is the failure this file exists to prevent.
 *
 * PID 1 in an agent container is the runner itself (`exec bun run
 * /app/src/index.ts`, see `src/container-runner.ts`), so `/proc/1/environ` holds
 * the real, current values. Reading them at startup is self-healing: a gateway
 * that moved or re-bound is picked up on the next container restart instead of
 * going stale in a config file written weeks ago.
 *
 * This is a near-copy of `ha-mcp/proxy.ts`. Deliberate: a skill has to install
 * standalone and cannot depend on `/add-homeassistant` being present.
 */
import fs from 'node:fs';

export interface ProxySettings {
  /** Proxy URL to route through, or undefined to connect directly. */
  proxy?: string;
  /** PEM contents of the CA to trust for the proxy's MITM certificate. */
  ca?: string;
  /** Human-readable note for the startup log — says which path was taken and why. */
  note: string;
}

/** Parse the NUL-separated `KEY=VALUE` blob at /proc/<pid>/environ. */
export function parseProcEnviron(blob: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of blob.split('\0')) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/**
 * PID 1 is only the agent runner inside a container. On the host — where
 * `discover.ts` and the install-time `tools/list` smoke run — it is the init
 * system, whose environment has nothing to do with this process and may well
 * carry a proxy meant for something else entirely.
 */
function inContainer(): boolean {
  return fs.existsSync('/.dockerenv');
}

export function readContainerEnv(path = '/proc/1/environ'): Record<string, string> {
  if (!inContainer()) return { ...process.env } as Record<string, string>;
  try {
    return parseProcEnviron(fs.readFileSync(path, 'utf8'));
  } catch {
    // PID 1 belongs to another user, or this is not Linux. Our own environment
    // is the same process tree, so it is the best remaining guess.
    return { ...process.env } as Record<string, string>;
  }
}

/** Case-insensitive lookup — proxy variables appear in both cases in the wild. */
function pick(env: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const hit = env[name] ?? env[name.toLowerCase()] ?? env[name.toUpperCase()];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * `NO_PROXY` is honored even though every ElevenLabs call needs the gateway. An
 * operator who excluded api.elevenlabs.io at the container level made a
 * deliberate statement, and quietly overriding it would be worse than the 401
 * that follows — which says exactly what happened.
 */
export function noProxyCovers(noProxy: string | undefined, host: string): boolean {
  if (!noProxy) return false;
  const target = host.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase().replace(/^\./, '');
    if (!entry) continue;
    if (entry === '*') return true;
    if (target === entry || target.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function resolveProxy(url: string, env: Record<string, string> = readContainerEnv()): ProxySettings {
  let host: string;
  let isHttps: boolean;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    isHttps = parsed.protocol === 'https:';
  } catch {
    return { note: `could not parse ${url} — connecting directly` };
  }

  if (noProxyCovers(pick(env, 'NO_PROXY'), host)) {
    return { note: `NO_PROXY covers ${host} — connecting directly, so no API key will be injected` };
  }

  const proxy = isHttps ? pick(env, 'HTTPS_PROXY', 'HTTP_PROXY') : pick(env, 'HTTP_PROXY', 'HTTPS_PROXY');
  if (!proxy) {
    return { note: 'no proxy found in the environment — connecting directly, so no API key will be injected' };
  }

  // The gateway terminates TLS with its own CA to be able to rewrite headers, so
  // its certificate must be trusted or the connection fails at the handshake.
  // Bun reads NODE_EXTRA_CA_CERTS only at process start, and this process
  // started without it, so the PEM is passed per-request instead.
  let ca: string | undefined;
  const caPath = pick(env, 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE');
  if (caPath) {
    try {
      ca = fs.readFileSync(caPath, 'utf8');
    } catch {
      // Leave `ca` unset — the handshake may still succeed from the image's
      // system store, and if it doesn't the TLS error names the problem better
      // than a guess here would.
    }
  }

  return { proxy, ca, note: `routing through ${proxy}${ca ? ' with the gateway CA' : ' (no CA file found)'}` };
}
