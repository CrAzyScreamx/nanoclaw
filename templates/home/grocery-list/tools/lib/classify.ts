/**
 * lib/classify.ts — the two questions this tool asks a model.
 *
 * It runs INSIDE the CLI, not in the agent. That placement is the whole point.
 * The obvious alternative — have the agent decide the aisle and pass it to
 * `add --category` — puts a data-shaping step back on a small model on the hot
 * path, which is exactly how the `note` qualifier ("5%", "250 g") got dropped
 * from every printed sheet before `printable` was made a single verb. The
 * agent's contract stays one command carrying the fields the user said; the
 * category is never something it holds.
 *
 * This file decides the aisle for every new product — once per PRODUCT, never
 * per purchase.
 *
 * EVERY FAILURE IS SILENT AND SAFE
 * --------------------------------
 * No credential, no network, a timeout, a malformed reply, an aisle the model
 * invented, an active cooldown, `MARKETY_CLASSIFY_DISABLED=1` — every one of
 * them returns null, and the caller files the product under the catch-all
 * aisle. **Nothing in this file throws.** An `add` must succeed with the
 * classifier completely unreachable; the group gets its item, the sheet gets a
 * heading, and `sweepUncategorised` tries again later.
 *
 * TRANSPORT — DO NOT MODERNISE THIS
 * ---------------------------------
 * Plain HTTPS to the Messages API through `curl`, which honours the
 * `HTTPS_PROXY` and `SSL_CERT_FILE` that the OneCLI gateway injects into every
 * agent container — so the credential is applied at the PROXY BOUNDARY and never
 * exists in this process. `curl` rather than `fetch` because the gateway
 * documents curl as proxy-aware; Bun's fetch proxy support is not something this
 * file should depend on. The body goes on stdin, so non-ASCII product names
 * never touch argv.
 *
 * There is NO real auth header. Which shape the gateway expects is an
 * install-level fact this code cannot know, so it tries the plausible ones once
 * and remembers the one that worked in `app_state`. After the first success
 * there is exactly one request per question; after a total failure a ten-minute
 * cooldown, so an outage costs one attempt per ten minutes rather than three on
 * every `add`.
 *
 * TWO MODEL USES, NOT ONE
 * -----------------------
 * `classify()` picks an aisle. `judgeProduct()` decides whether a typed name is
 * the same product as one already on file — and it is written to REFUSE rather
 * than to match, because a false "same" costs a wrong alias that then resolves
 * silently for ever, while a false "different" costs one question the group
 * answers once. Both prompts live in the locale pack.
 */
import { spawnSync } from 'node:child_process';

import { catchAllCategoryId, foldForCompare, listCategories } from './categories.ts';
import { db } from './db.ts';
import type { LocalePack } from './locale.ts';
import { t } from './locale.ts';
import { setProductCategory, uncategorisedProductsAfter } from './products.ts';
import type { CategoryRow } from './types.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.MARKETY_CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_S = Number(process.env.MARKETY_CLASSIFY_TIMEOUT || 8);
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Auth shapes to try, best guess first. `onecli-managed` / `placeholder` are
 * sentinels, not credentials — no secret is ever placed here and none ever
 * should be. See the header: the gateway rewrites this at the proxy boundary.
 */
const AUTH_SHAPES: { id: string; headers: string[] }[] = [
  { id: 'x-api-key', headers: ['x-api-key: onecli-managed'] },
  { id: 'bearer', headers: ['authorization: Bearer placeholder'] },
  { id: 'none', headers: [] },
];

/**
 * Why an answer is or is not there.
 *
 * `auth` and `transport` are kept apart deliberately: the first means the
 * gateway is not injecting a credential for this host, the second means the
 * request never reached HTTP at all. They need different fixes, and collapsing
 * them sends the operator looking in the wrong place.
 */
export type ClassifyHow =
  | 'model'
  | 'disabled'
  | 'cooldown'
  | 'no-answer'
  | 'unusable-answer'
  | 'auth'
  | 'transport';

/** The four outcomes that mean "we could not ask", as opposed to "we asked". */
const UNREACHABLE: ReadonlySet<ClassifyHow> = new Set<ClassifyHow>([
  'disabled',
  'cooldown',
  'auth',
  'transport',
]);

/* -------------------------------------------------------------- small state */

/**
 * Key/value scratch for things that are neither list data nor config: the
 * remembered auth shape, the cooldown deadline and the sweep cursor.
 *
 * A table rather than a file because it is written on the hot path from a
 * transactionless CLI that may be running twice at once. Operator settings live
 * in `config.json` instead — see lib/locale.ts.
 *
 * `bootstrap()` calls this before every verb, so the table always exists by the
 * time `getState` runs.
 */
export function ensureStateSchema(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function getState(key: string): string | null {
  const row = db().query('SELECT value FROM app_state WHERE key = $key').get({ $key: key }) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

function setState(key: string, value: string): void {
  db()
    .query(
      'INSERT INTO app_state (key, value) VALUES ($key, $value)' +
        ' ON CONFLICT(key) DO UPDATE SET value = $value',
    )
    .run({ $key: key, $value: value });
}

/* ------------------------------------------------------------------ the call */

interface HttpResult {
  status: number;
  body: string;
  error?: string;
}

/** One request. Returns a status of 0 for anything that never reached HTTP. */
function post(headers: string[], payload: unknown): HttpResult {
  const args = [
    '-sS',
    '--max-time',
    String(TIMEOUT_S),
    '-w',
    '\n%{http_code}',
    '-X',
    'POST',
    API_URL,
    '-H',
    'content-type: application/json',
    '-H',
    'anthropic-version: 2023-06-01',
  ];
  for (const header of headers) args.push('-H', header);
  args.push('-d', '@-'); // body on stdin — non-ASCII never touches argv

  const result = spawnSync('curl', args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: (TIMEOUT_S + 4) * 1000,
  });

  if (result.error) return { status: 0, body: '', error: String(result.error) };
  const out = result.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const status = Number(out.slice(cut + 1).trim());
  return {
    status: Number.isFinite(status) ? status : 0,
    body: out.slice(0, Math.max(0, cut)),
    error: result.stderr?.trim() || undefined,
  };
}

/** Pull the assistant's text out of a Messages API response. */
function textOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { content?: { type?: string; text?: string }[] };
    if (!Array.isArray(parsed.content)) return null;
    const text = parsed.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function payloadFor(system: string, user: string, maxTokens: number): unknown {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  };
}

/**
 * One question, with all the failure handling this file promises: the disable
 * switch, the cooldown, the remembered auth shape, and a null on every path that
 * does not produce text.
 *
 * Both public callers go through here, so a gateway outage costs one attempt per
 * ten minutes across the whole CLI rather than one per feature.
 */
function ask(payload: unknown): { text: string | null; how: ClassifyHow; detail?: string } {
  if (process.env.MARKETY_CLASSIFY_DISABLED === '1') {
    return { text: null, how: 'disabled', detail: 'MARKETY_CLASSIFY_DISABLED=1' };
  }

  const until = Number(getState('classify_cooldown_until') || 0);
  if (Date.now() < until) {
    return {
      text: null,
      how: 'cooldown',
      detail: `classifier in cooldown until ${new Date(until).toISOString()}`,
    };
  }

  // Remembered shape first, then the rest — so the steady state is one request.
  const remembered = getState('classify_auth_shape');
  const order = [...AUTH_SHAPES].sort(
    (a, b) => Number(b.id === remembered) - Number(a.id === remembered),
  );

  const failures: string[] = [];
  let reachedHttp = false;
  for (const shape of order) {
    const result = post(shape.headers, payload);
    if (result.status !== 200) {
      failures.push(
        `${shape.id}: HTTP ${result.status}${result.error ? ` ${result.error.slice(0, 120)}` : ''}`,
      );
      // A transport-level failure (status 0) will fail identically for every
      // shape — no point paying the timeout three times.
      if (result.status === 0) break;
      reachedHttp = true;
      continue;
    }

    setState('classify_auth_shape', shape.id);
    const text = textOf(result.body);
    if (!text) return { text: null, how: 'no-answer', detail: `${shape.id}: empty reply` };
    return { text, how: 'model', detail: shape.id };
  }

  setState('classify_cooldown_until', String(Date.now() + COOLDOWN_MS));
  return { text: null, how: reachedHttp ? 'auth' : 'transport', detail: failures.join('; ') };
}

/* ----------------------------------------------------------------- the aisle */

export interface ClassifyOutcome {
  /** The chosen aisle, or null when the model could not be consulted. */
  category: CategoryRow | null;
  how: ClassifyHow;
  /** Operator-facing detail. Never shown to the group. */
  detail?: string;
}

/**
 * Which aisle does this product belong to?
 *
 * Returns an aisle from `cats` or null. An answer that is not one of the offered
 * names is discarded rather than trusted: a hallucinated aisle would print a
 * heading that does not exist on the sheet. The comparison is an exact
 * fold-match (`foldForCompare`), because the prompt tells the model to answer
 * word for word from the list it was given — anything else is treated as no
 * answer rather than guessed at.
 */
export function classify(name: string, cats: CategoryRow[], pack: LocalePack): ClassifyOutcome {
  if (cats.length === 0) return { category: null, how: 'no-answer', detail: 'no aisles offered' };

  const asked = ask(aislePayload(name, cats, pack));
  if (!asked.text) return { category: null, how: asked.how, detail: asked.detail };

  const wanted = foldForCompare(asked.text);
  const hit = cats.find((category) => foldForCompare(category.name) === wanted);
  if (!hit) {
    return {
      category: null,
      how: 'unusable-answer',
      detail: `model said ${JSON.stringify(asked.text)}`,
    };
  }
  return { category: hit, how: 'model', detail: `${asked.detail} → ${hit.name}` };
}

function aislePayload(name: string, cats: CategoryRow[], pack: LocalePack): unknown {
  return payloadFor(
    pack.prompts.aisle,
    t(pack, 'promptAisleUser', {
      categories: cats.map((category) => `- ${category.name}`).join('\n'),
      name,
    }),
    32,
  );
}

/* -------------------------------------------------------- product identity */

export interface JudgeOutcome {
  /** Index into the offered list, or null for "none of these is the same". */
  choice: number | null;
  how: ClassifyHow;
  detail?: string;
}

/**
 * Is `typed` the same product as one of `options`?
 *
 * Returns the chosen index, or null for "none of them" — which is also what
 * every failure returns, so a gateway outage degrades to trusting the string
 * rules rather than to a broken `add`.
 *
 * The prompt is written to REFUSE. The string rules propose generously: a
 * substring match and a token-superset both fire on pairs that are plainly
 * different products once a size, flavour or brand is read. The pack's identity
 * prompt is what has to say so, and it is the one place where being conservative
 * is worth a question.
 *
 * Note what the CALLER must do with `how`: a model that answered "none of these"
 * has actively ruled the candidates out, so creating a new product is right and
 * the group is never bothered. A model that could not be reached has ruled out
 * nothing, so the string candidates still stand and the question goes to the
 * group instead. The feature degrades to asking more often, never to guessing.
 */
export function judgeProduct(typed: string, options: string[], pack: LocalePack): JudgeOutcome {
  if (options.length === 0) return { choice: null, how: 'no-answer', detail: 'no candidates' };

  const asked = ask(
    payloadFor(
      pack.prompts.identity,
      t(pack, 'promptIdentityUser', {
        typed,
        options: options.map((option, index) => `${index + 1}. ${option}`).join('\n'),
      }),
      8,
    ),
  );
  if (!asked.text) return { choice: null, how: asked.how, detail: asked.detail };

  const digits = asked.text.match(/\d+/);
  if (!digits) {
    return { choice: null, how: 'unusable-answer', detail: `model said ${JSON.stringify(asked.text)}` };
  }
  const chosen = Number(digits[0]);
  if (chosen === 0) return { choice: null, how: 'model', detail: `${asked.detail} → none` };
  if (chosen < 1 || chosen > options.length) {
    return { choice: null, how: 'unusable-answer', detail: `model said ${JSON.stringify(asked.text)}` };
  }
  return { choice: chosen - 1, how: 'model', detail: `${asked.detail} → ${options[chosen - 1]}` };
}

/* ----------------------------------------------------------------- the sweep */

/**
 * Give products that landed in the catch-all another chance, a few at a time.
 *
 * `bootstrap()` calls this before every verb, so an outage costs a temporarily
 * untidy sheet rather than a permanently wrong one. Bounded because it runs on
 * the hot path: an unbounded sweep over a long backlog would turn one `add` into
 * a hundred API calls and a chat reply that arrives a minute late.
 *
 * `classify_sweep_cursor` is the highest product id already attempted — most
 * products in the catch-all belong there, and without a high-water mark this
 * would re-ask about every one of them for ever. It advances only when the model
 * was actually REACHABLE: an unasked question must be retried, while an answer
 * (including "no answer") is a fact about the product that a retry will not
 * change, so one stubborn product cannot block the ones behind it.
 *
 * Returns how many products were moved. **Never throws** — a classifier problem
 * is never a reason to fail the verb that follows.
 */
export function sweepUncategorised(pack: LocalePack, limit: number): number {
  if (limit <= 0) return 0;
  try {
    const cursor = Number(getState('classify_sweep_cursor') || 0);
    const pending = uncategorisedProductsAfter(Number.isFinite(cursor) ? cursor : 0, limit);
    if (pending.length === 0) return 0;

    const cats = listCategories();
    const catchAll = catchAllCategoryId();
    let moved = 0;
    let highest = cursor;

    for (const product of pending) {
      const outcome = classify(product.name, cats, pack);
      if (UNREACHABLE.has(outcome.how)) break; // ask again next run; cursor stays put
      highest = Math.max(highest, product.id);
      if (outcome.category && outcome.category.id !== catchAll && outcome.category.id !== product.category_id) {
        setProductCategory(product.id, outcome.category.id);
        moved++;
      }
    }

    if (highest > cursor) setState('classify_sweep_cursor', String(highest));
    return moved;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------- the diagnostic */

/**
 * Try every auth shape once and report what each did, ignoring the cooldown.
 *
 * This is the one-command answer to "is the classifier actually wired?", which
 * cannot be determined from the host: the OneCLI gateway injects credentials
 * only for traffic originating inside an agent container, so the check has to
 * run where `add` runs. A shape that succeeds is remembered and the cooldown is
 * cleared, so a successful check also configures the tool.
 *
 * Exposed as `grocery.ts categories --probe`; `SETUP.md` uses it.
 */
export function probe(name: string, cats: CategoryRow[], pack: LocalePack): string[] {
  const lines: string[] = [];
  const payload = aislePayload(name, cats, pack);

  for (const shape of AUTH_SHAPES) {
    const result = post(shape.headers, payload);
    if (result.status === 200) {
      const text = textOf(result.body);
      const hit = text
        ? cats.find((category) => foldForCompare(category.name) === foldForCompare(text))
        : undefined;
      lines.push(
        `${shape.id.padEnd(10)} HTTP 200  answer=${JSON.stringify(text)}  ` +
          (hit ? `matched "${hit.name}"` : 'NOT a known aisle'),
      );
      setState('classify_auth_shape', shape.id);
      setState('classify_cooldown_until', '0');
    } else {
      const snippet = result.body.replace(/\s+/g, ' ').slice(0, 160);
      lines.push(
        `${shape.id.padEnd(10)} HTTP ${result.status}  ` +
          (snippet || result.error?.slice(0, 160) || '(no body)'),
      );
    }
  }
  return lines;
}
