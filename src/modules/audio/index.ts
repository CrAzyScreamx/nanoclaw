/**
 * Audio transcription module.
 *
 * Self-registers at import time: hands `transcribeContent` to the router so
 * inbound audio is transcribed before the message is persisted into the
 * session's inbound.db.
 *
 * Registration is UNCONDITIONAL by design. The feature gate lives inside
 * `transcribeContent` (step 1: no `VOICEBOX_URL` -> return content unchanged),
 * which keeps the core reach-in a single call and makes registration
 * observable in tests regardless of environment — see the "Registration
 * reach-ins: behavior, not structural" rule in docs/skill-guidelines.md.
 * With no server configured the hook is an immediate passthrough, so the cost
 * of registering-but-inert is one function call per message.
 */
import { VOICEBOX_URL } from '../../config.js';
import { log } from '../../log.js';
import { setAudioTranscriber } from '../../router.js';

import { transcribeContent } from './transcribe-inbound.js';

setAudioTranscriber(transcribeContent);

if (VOICEBOX_URL) {
  log.info('Audio transcription enabled', { voiceboxUrl: VOICEBOX_URL });
} else {
  log.debug('Audio transcription registered but inert (VOICEBOX_URL unset)');
}

export { transcribeContent } from './transcribe-inbound.js';
export * from './voicebox.js';
