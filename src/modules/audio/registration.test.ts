/**
 * Guards the one code reach-in this skill makes into core: the
 * `import './audio/index.js';` line appended to src/modules/index.ts.
 *
 * This imports the REAL modules barrel — not the audio module directly.
 * Importing the module itself would self-register and stay green with the
 * barrel line deleted, which is the trap docs/skill-guidelines.md calls out
 * for registration reach-ins. Driving the barrel means this goes red on a
 * deleted barrel line AND on a barrel that no longer evaluates.
 *
 * The audio module registers unconditionally at import time; whether
 * transcription actually runs is gated inside the transcriber by
 * VOICEBOX_URL. That separation is what makes registration observable here
 * without any VoiceBox server or .env present.
 */
import { describe, expect, it } from 'vitest';

// Production barrel — the side-effect import is the thing under test.
import '../index.js';

import { hasAudioTranscriber } from '../../router.js';

describe('audio module registration', () => {
  it('wires an audio transcriber into the router via the modules barrel', () => {
    expect(hasAudioTranscriber()).toBe(true);
  });
});
