// ============================================================================
// lib/http.ts — the only place this template talks HTTP.
//
// NO AUTH HEADER IS EVER SET HERE, OR ANYWHERE ELSE IN THIS TEMPLATE.
// The OneCLI gateway is a MITM egress proxy that injects credentials by
// destination host: it adds `xi-api-key` for api.elevenlabs.io, `Authorization`
// for api.twilio.com, and so on. Nothing in the container holds a key, reads a
// key out of the environment, or writes one to disk.
//
// Why that works at all: these scripts are run with `bun` through the agent's
// Bash tool, so they are ordinary children of the agent process and inherit the
// full container environment — including HTTPS_PROXY and NODE_EXTRA_CA_CERTS.
// Bun's fetch honours both from the environment, which is why the proxy and the
// MITM CA "just work" here with zero per-request configuration. (A stdio MCP
// server would NOT work: its transport forwards only HOME, LOGNAME, PATH,
// SHELL, TERM and USER, so the proxy and CA are dropped and every call 401s.)
//
// Consequences, all deliberate:
//   * no per-request proxy option is set,
//   * TLS verification is never disabled — NODE_TLS_REJECT_UNAUTHORIZED is not
//     read and not written,
//   * a 401/403 means the vault entry is missing or wrong, so it is translated
//     into a message naming the exact fix for that host.
// ============================================================================

import {
  AuthRequiredError,
  CONNECT_REFERENCE,
  ExitCode,
  HttpError,
  NotFoundError,
  VoiceToolError,
} from './provider.ts';

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;   // credential headers are rejected
  timeoutMs?: number;                 // default 30000
  service?: string;                   // label used in error messages
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_SNIPPET_MAX = 500;

/** Header names a caller must never set: the gateway owns all of them. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'xi-api-key',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'cookie',
]);

interface HostHint {
  /** Vault entry name suggested by the recipe. */
  name: string;
  /** Header the gateway must inject for this host. */
  header: string;
  /** Value format the vault entry must use. */
  valueFormat: string;
  /** What the stored value has to be. */
  valueExpr: string;
  /** Extra sentence appended to the fix, when the host has a gotcha. */
  note?: string;
}

/**
 * The failure mode every `Basic {value}` host shares, kept separate so a second
 * one can reuse it: GNU coreutils `base64` wraps at 76 columns, and a
 * `sid:secret` pair is longer than that, so the naive `printf … | base64` recipe
 * embeds a NEWLINE in the header value. The vault stores it happily and the API
 * answers 401 — identical, from here, to a wrong key. It is the single likeliest
 * cause of a 401 on a freshly created entry.
 */
const BASE64_WRAP_NOTE =
  'build the value with `| base64 | tr -d \'\\n\'` — a bare `| base64` wraps at 76 columns and ' +
  'puts a newline inside the header, which 401s exactly like a wrong key';

/**
 * Per-host vault recipes. These are instructions, not credentials — every
 * `valueExpr` is a description or a host-side shell variable, never a value.
 */
const HOST_HINTS: Record<string, HostHint> = {
  'api.elevenlabs.io': {
    name: 'ElevenLabs',
    header: 'xi-api-key',
    valueFormat: '{value}',
    valueExpr: '"$XI_API_KEY"',
    note: 'the value format must be {value}, not Bearer {value}',
  },
  'api.twilio.com': {
    name: 'Twilio',
    header: 'Authorization',
    valueFormat: 'Basic {value}',
    valueExpr: '"<base64 of ApiKeySid:ApiKeySecret>"',
    note:
      'the value is the base64 of an API Key SID (SK…) and that key\'s secret — NOT the Account ' +
      'SID and Auth Token. The Account SID stays in the URL and in config.json. Twilio also ' +
      'answers 401 when the key itself is valid but was issued on a different account than the ' +
      `Account SID recorded here. And ${BASE64_WRAP_NOTE}`,
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function serviceFor(url: string, service?: string): string {
  if (service) return service;
  const hint = HOST_HINTS[hostOf(url).toLowerCase()];
  return hint ? hint.name : hostOf(url);
}

function buildUrl(url: string, query?: RequestOptions['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function buildHeaders(opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      // A programming error, not a runtime condition: the gateway injects
      // credentials by destination host and a hand-rolled header would either
      // be overwritten or leak a value into a container process.
      throw new VoiceToolError(
        `Refusing to send a "${key}" header. Credentials are injected by the OneCLI gateway per destination host; tools never set them. See ${CONNECT_REFERENCE}`,
        { code: 'credential_header', exitCode: ExitCode.UNEXPECTED, hint: CONNECT_REFERENCE },
      );
    }
    headers[key] = value;
  }
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  else if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return headers;
}

function snippet(body: string | null): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > BODY_SNIPPET_MAX ? `${flat.slice(0, BODY_SNIPPET_MAX)}…` : flat;
}

/** The message a 401/403 turns into: the exact fix for this host. */
function authMessage(url: string, status: number, service: string): string {
  const host = hostOf(url);
  const hint = HOST_HINTS[host.toLowerCase()];
  const head = `${service} rejected the request (${status}). No credential is reaching ${host}.`;
  const recipe = hint
    ? ` Fix: on the NanoClaw host run \`onecli secrets create --name "${hint.name}" --type generic --value ${hint.valueExpr} --host-pattern "${host}" --header-name "${hint.header}" --value-format "${hint.valueFormat}"\`${hint.note ? ` (${hint.note})` : ''}.`
    : ` Fix: add a vault entry on the NanoClaw host whose host pattern is "${host}", with the header name and value format this API expects — \`onecli secrets create --name "<service>" --type generic --value "<the key>" --host-pattern "${host}" --header-name "<header>" --value-format "<format>"\`.`;
  const mode = ' If the key is already in the vault, the agent may be in selective secret mode: `onecli agents set-secret-mode --id <id> --mode all`.';
  return `${head}${recipe}${mode} Full walkthrough: ${CONNECT_REFERENCE}`;
}

async function readBody(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function transportError(url: string, method: string, service: string, err: unknown, timeoutMs: number): HttpError {
  const host = hostOf(url);
  const name = err instanceof Error ? err.name : '';
  const detail = err instanceof Error ? err.message : String(err);
  const cause =
    name === 'TimeoutError' || name === 'AbortError'
      ? `the request to ${host} did not finish within ${timeoutMs}ms`
      : `${host} could not be reached — the OneCLI egress proxy may be down, DNS may not resolve, or the connection was refused`;
  return new HttpError({
    status: 0,
    method,
    url,
    body: null,
    code: 'network_error',
    exitCode: ExitCode.UPSTREAM,
    message: `${service} request failed: ${cause}. (${detail})`,
    hint: `Check that the container still has HTTPS_PROXY and NODE_EXTRA_CA_CERTS set, then retry. Setup: ${CONNECT_REFERENCE}`,
  });
}

export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const target = buildUrl(url, opts.query);
  const service = serviceFor(target, opts.service);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = buildHeaders(opts);

  let body: string | undefined;
  if (opts.json !== undefined) body = JSON.stringify(opts.json);
  else if (opts.form) body = new URLSearchParams(opts.form).toString();

  let res: Response;
  try {
    // No `proxy`, no `tls` — both come from the inherited container env.
    res = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw transportError(target, method, service, err, timeoutMs);
  }

  if (!res.ok) {
    const text = await readBody(res);
    if (res.status === 401 || res.status === 403) {
      throw new AuthRequiredError({
        status: res.status,
        method,
        url: target,
        body: snippet(text),
        message: authMessage(target, res.status, service),
      });
    }
    if (res.status === 404) {
      throw new NotFoundError({
        method,
        url: target,
        body: snippet(text),
        message: `${service} has no such resource (404 on ${method} ${target}).`,
      });
    }
    const detail = snippet(text);
    throw new HttpError({
      status: res.status,
      method,
      url: target,
      body: detail,
      message: `${service} returned ${res.status} for ${method} ${target}${detail ? `: ${detail}` : '.'}`,
    });
  }

  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await readBody(res);
  if (!text || text.trim() === '') return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError({
      status: res.status,
      method,
      url: target,
      body: snippet(text),
      code: 'bad_json',
      message: `${service} returned ${res.status} with a body that is not valid JSON.`,
    });
  }
}

export async function requestVoid(url: string, opts: RequestOptions = {}): Promise<void> {
  await request<unknown>(url, opts);
}
