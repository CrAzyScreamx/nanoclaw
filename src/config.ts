import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'DEFAULT_AGENT_PROVIDER',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_PIDS_LIMIT',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'NANOCLAW_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
  'VOICEBOX_URL',
  'VOICEBOX_STT_MODEL',
  'VOICEBOX_STT_LANGUAGE',
  'VOICEBOX_TIMEOUT_MS',
]);

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_NAME .env key
 * directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// Instance-wide default agent provider for newly created groups. `claude` (the
// built-in provider) when unset, so existing installs are unaffected on upgrade.
// Applied only at group-creation time (stamped onto the config row) — never in
// provider resolution — so existing groups are never retroactively flipped.
// Per-group `ncl groups config update --provider` still overrides it.
export const DEFAULT_AGENT_PROVIDER = (
  process.env.DEFAULT_AGENT_PROVIDER ||
  envConfig.DEFAULT_AGENT_PROVIDER ||
  'claude'
).toLowerCase();

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_HAS_OWN_NUMBER
 * .env key directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
// Local agent-template library. Committed but ships empty (+ README). Resolved
// once at load. Override to another LOCAL path via NANOCLAW_TEMPLATES_DIR; never
// a remote URL, never an ncl flag, never runtime-mutable.
export const TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR
  ? path.resolve(process.env.NANOCLAW_TEMPLATES_DIR)
  : path.resolve(PROJECT_ROOT, 'templates');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
// Per-container resource caps, passed through to `docker run`. Default empty =
// no flag added = today's unbounded behavior (don't OOM existing OSS workloads).
// Operators opt in: CONTAINER_CPU_LIMIT=2, CONTAINER_MEMORY_LIMIT=8g.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '';

// Fork-bomb backstop. cgroups v2 counts THREADS, not processes, and Chromium is
// thread-hungry — a browsing agent with several tabs open runs into the high
// hundreds. Keep well above that; too low a cap kills the container mid-turn or
// blocks it from spawning subprocesses, and neither is reported as a PID limit.
// Empty = no cap.
export const CONTAINER_PIDS_LIMIT = process.env.CONTAINER_PIDS_LIMIT ?? envConfig.CONTAINER_PIDS_LIMIT ?? '2048';

// Egress lockdown — force all agent traffic through the OneCLI gateway on a
// no-internet Docker network. Off by default; consumed by src/egress-lockdown.ts.
export const EGRESS_LOCKDOWN = (process.env.NANOCLAW_EGRESS_LOCKDOWN || envConfig.NANOCLAW_EGRESS_LOCKDOWN) === 'true';
export const EGRESS_NETWORK =
  process.env.NANOCLAW_EGRESS_NETWORK || envConfig.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress';
export const ONECLI_GATEWAY_CONTAINER =
  process.env.ONECLI_GATEWAY_CONTAINER || envConfig.ONECLI_GATEWAY_CONTAINER || 'onecli';

// User-defined Docker network for agent containers (non-lockdown path). Empty =
// today's behavior: containers join the default `bridge` network. When set, each
// agent container joins ONLY this network (never bridge), letting it reach other
// containers on it by name. The network is auto-created (plain bridge driver) if
// absent. Ignored when egress lockdown is on — that path forces EGRESS_NETWORK.
export const CONTAINER_NETWORK = process.env.NANOCLAW_NETWORK || envConfig.NANOCLAW_NETWORK || '';

// VoiceBox speech-to-text. Empty URL = the audio-transcription module stays
// dormant and inbound voice notes route exactly as they do today.
export const VOICEBOX_URL = process.env.VOICEBOX_URL || envConfig.VOICEBOX_URL || '';
// Model SIZE, bare — e.g. `ivrit-turbo`, not `whisper-ivrit-turbo`. VoiceBox is
// inconsistent here: `/models/status` and `/models/download` name models in the
// prefixed `whisper-<size>` form, but `/transcribe` rejects that form with HTTP
// 400 and wants the bare `<size>`. Verified live against a running server.
// Empty = let the server pick its default.
export const VOICEBOX_STT_MODEL = process.env.VOICEBOX_STT_MODEL || envConfig.VOICEBOX_STT_MODEL || '';
// Empty = let the server auto-detect the spoken language.
export const VOICEBOX_STT_LANGUAGE = process.env.VOICEBOX_STT_LANGUAGE || envConfig.VOICEBOX_STT_LANGUAGE || '';
// Hard ceiling on one transcription request. A voice note that can't be
// transcribed in time must not hold up routing, so this stays modest.
function resolveVoiceboxTimeoutMs(): number {
  const raw = process.env.VOICEBOX_TIMEOUT_MS || envConfig.VOICEBOX_TIMEOUT_MS || '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}
export const VOICEBOX_TIMEOUT_MS = resolveVoiceboxTimeoutMs();

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
