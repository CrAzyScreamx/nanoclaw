/**
 * Home Assistant REST client for the `ha-mcp` server.
 *
 * Two auth modes, decided at setup and recorded in config.env:
 *
 *   gateway — the request goes out with no Authorization header and the OneCLI
 *             credential proxy adds one in flight. The token never enters the
 *             container. Sending a header here as well would be two
 *             Authorization headers and a 400, so don't.
 *   token   — the Home Assistant URL is bypassed from the proxy, so nothing
 *             injects anything and this client sends the header itself from
 *             config.env.
 */
import type { Connection } from './config.js';
import { resolveProxy, type ProxySettings } from './proxy.js';

export interface HaResponse {
  status: number;
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown;
}

export class HaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

export class HomeAssistant {
  readonly proxy: ProxySettings;

  constructor(private readonly conn: Connection) {
    // Resolved once at construction. The proxy does not change under a running
    // container, and re-reading /proc on every call would only add a syscall
    // per request for no new information.
    this.proxy = resolveProxy(conn.url, conn.auth);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.conn.auth === 'token' && this.conn.token) {
      h.Authorization = `Bearer ${this.conn.token}`;
    }
    return h;
  }

  async request(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<HaResponse> {
    const url = `${this.conn.url}${pathname}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Bun-specific: the proxy has to be passed per-request because this
        // process never received the container's proxy environment. See proxy.ts.
        ...(this.proxy.proxy ? { proxy: this.proxy.proxy } : {}),
        ...(this.proxy.ca ? { tls: { ca: this.proxy.ca } } : {}),
      });
    } catch (e) {
      // Network-level failure. Deliberately not retried: a `clean_area` or an
      // unlock that timed out may well have been dispatched, and a retry would
      // repeat a physical action. Report and let a human decide.
      const msg = e instanceof Error ? e.message : String(e);
      throw new HaError(`Could not reach Home Assistant at ${this.conn.url}: ${msg}`);
    }

    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON — keep the text, some HA endpoints answer plain */
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new HaError(
        this.conn.auth === 'gateway'
          ? `Home Assistant rejected the request (401). In gateway mode this means the OneCLI proxy did not inject the token (${this.proxy.note}) — an operator has to re-run /add-homeassistant.`
          : 'Home Assistant rejected the token (401). It is wrong, expired, or was revoked — an operator has to re-run /add-homeassistant.',
        res.status,
      );
    }
    if (res.status >= 400) {
      throw new HaError(`Home Assistant returned ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`, res.status);
    }
    return { status: res.status, body };
  }

  async getState(entityId: string): Promise<Record<string, unknown>> {
    const { body } = await this.request(`/api/states/${encodeURIComponent(entityId)}`);
    if (typeof body !== 'object' || body === null) {
      throw new HaError(`Unexpected state payload for ${entityId}`);
    }
    return body as Record<string, unknown>;
  }

  /**
   * `service` is the full `domain.service` pair, because that is how the
   * operator recorded it in services.json — keeping the two halves together
   * means a wiring mistake shows up here rather than as a wrong URL.
   */
  async callService(service: string, data: Record<string, unknown>): Promise<HaResponse> {
    const dot = service.indexOf('.');
    if (dot <= 0 || dot === service.length - 1) {
      throw new HaError(`Malformed service "${service}" — expected "domain.service"`);
    }
    const domain = service.slice(0, dot);
    const name = service.slice(dot + 1);
    return this.request(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: data,
    });
  }

  /** Render a Jinja template server-side. The body is JSON, so no shell quoting is involved. */
  async template(template: string): Promise<string> {
    const { body } = await this.request('/api/template', { method: 'POST', body: { template } });
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
}

export interface Area {
  area_id: string;
  name: string;
}

const AREAS_TEMPLATE =
  '{% set ns = namespace(l=[]) %}' +
  '{% for a in areas() %}{% set ns.l = ns.l + [{"area_id": a, "name": area_name(a)}] %}{% endfor %}' +
  '{{ ns.l | to_json(ensure_ascii=false) }}';

export async function listAreas(ha: HomeAssistant): Promise<Area[]> {
  const raw = await ha.template(AREAS_TEMPLATE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HaError(`Home Assistant returned an unreadable area list: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new HaError('Home Assistant returned a non-list area payload');
  return parsed as Area[];
}
