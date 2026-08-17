// ============================================================================
// lib/registry.ts — name → provider.
//
// Only `elevenlabs` is implemented. `openai` and `gemini` are named here on
// purpose, with the concrete reason each one cannot work from inside an agent
// container, so an unknown-provider failure is never mysterious. No stub
// adapter files ship for them: adding a provider means writing a subclass of
// VoiceProvider, not filling in a placeholder.
// ============================================================================

import { ProviderNotAvailableError, type VoiceProvider } from './provider.ts';
import { readConfig } from './state.ts';

const PROVIDERS_REFERENCE = 'skills/voice-line/references/providers.md';

const DEFAULT_PROVIDER = 'elevenlabs';

/** Why a named-but-unimplemented provider is not here. */
const NOT_IMPLEMENTED: Record<string, string> = {
  openai:
    'OpenAI Realtime is not implemented here: accepting a call requires a public HTTPS webhook to receive `realtime.call.incoming`, and an agent container has no inbound ingress. ' +
    `See ${PROVIDERS_REFERENCE}`,
  gemini:
    'Gemini Live is not implemented here: it has no first-party PSTN telephony, so a line would need a separate media bridge to carry audio. ' +
    `See ${PROVIDERS_REFERENCE}`,
};

/** What each provider name resolves to today — printable by any leaf CLI. */
export const PROVIDER_STATUS: { name: string; implemented: boolean; reason?: string }[] = [
  { name: 'elevenlabs', implemented: true },
  { name: 'openai', implemented: false, reason: NOT_IMPLEMENTED.openai },
  { name: 'gemini', implemented: false, reason: NOT_IMPLEMENTED.gemini },
];

export const KNOWN_PROVIDERS: string[] = PROVIDER_STATUS.map((entry) => entry.name);

function configuredProvider(): string {
  try {
    const configured = readConfig().provider;
    return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

/**
 * Resolves a provider by name, defaulting to config.json's `provider` field and
 * then to elevenlabs. Constructing the provider is the first thing that can
 * touch the network, so `--help` paths must never call this.
 */
export async function getProvider(name?: string): Promise<VoiceProvider> {
  const requested = (name ?? configuredProvider()).trim().toLowerCase();

  if (requested === 'elevenlabs') {
    const module = await import('../providers/elevenlabs/provider.ts');
    return new module.ElevenLabsProvider();
  }

  const reason = NOT_IMPLEMENTED[requested];
  if (reason) throw new ProviderNotAvailableError(requested, reason);

  throw new ProviderNotAvailableError(
    requested,
    `unknown provider name. Known names: ${KNOWN_PROVIDERS.join(', ')} — only "elevenlabs" is implemented. See ${PROVIDERS_REFERENCE}`,
  );
}
