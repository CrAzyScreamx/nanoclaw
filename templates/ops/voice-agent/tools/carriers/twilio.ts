/**
 * carriers/twilio.ts — ending a live call on a Twilio-carried line.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   Status=completed
 *
 * AUTHENTICATION IS AN API KEY, NOT THE ACCOUNT AUTH TOKEN. Twilio's REST API
 * takes HTTP Basic where the username is an API Key SID (`SK…`) and the password
 * is that key's secret. The Account SID still appears in the URL — it identifies
 * *which account* the call belongs to, not *who is asking* — so the two are not
 * interchangeable and both are needed:
 *
 *   Account SID   → /workspace/agent/voice-line/config.json (an identifier)
 *   API Key SID + secret → the OneCLI vault, host `api.twilio.com`,
 *                          header `Authorization`, value format `Basic {value}`,
 *                          value = base64 of `SK…:<the key secret>`
 *
 * Why the API key and not the Auth Token: the Auth Token is the account's root
 * credential — it cannot be scoped, and revoking it breaks every other
 * integration on the account at once. An API key is revocable on its own, and a
 * Restricted key can be narrowed to the Voice Calls resource, which is the only
 * thing this template ever touches on Twilio.
 *
 * This file sends NO auth header and reads no credential.
 */

import { request, requestVoid } from '../lib/http.ts';
import { UnsupportedCapabilityError, type Carrier, type CarrierCheck } from '../lib/provider.ts';
import type { VoiceLineConfig } from '../lib/state.ts';

const HOST = 'https://api.twilio.com';
const SERVICE = 'Twilio';

export const TWILIO_MISSING_SID =
  'Twilio hang-up needs the Account SID in /workspace/agent/voice-line/config.json ' +
  '(an identifier, not a secret) and a Twilio API Key — the SID (SK…) and its secret, ' +
  'base64 as SK…:secret — in the OneCLI vault for host api.twilio.com. The Account ' +
  'Auth Token is NOT what goes in the vault — see references/connect-provider.md';

/** What a passing probe does, and does not, establish. Said out loud, both halves. */
const CHECK_PASSED =
  'the vault credential reached api.twilio.com and Twilio accepted it for this Account SID. ' +
  'That proves the API key is valid and can READ this account\'s calls; it does not prove it ' +
  'can UPDATE one (a Restricted key can be granted read without write), and it says nothing ' +
  'about whether a given call will actually drop.';

/** A carrier that refuses loudly. It must never look like a successful hang-up. */
function denied(reason: string): Carrier {
  return {
    kind: 'twilio',
    unavailable: reason,
    async endCall() {
      throw new UnsupportedCapabilityError('twilio', 'end this call', reason);
    },
    async check(): Promise<CarrierCheck> {
      return { ok: false, probe: 'nothing was sent', detail: reason };
    },
  };
}

export function createTwilioCarrier(cfg: VoiceLineConfig): Carrier {
  const accountSid = cfg.twilio?.accountSid?.trim();
  if (!accountSid) return denied(TWILIO_MISSING_SID);

  const account = `${HOST}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;

  return {
    kind: 'twilio',
    unavailable: null,

    /**
     * The read-only half of the same credential path the hang-up uses: same
     * host, same header, same account. It reads the Calls resource rather than
     * the Account resource on purpose — a Standard API key is denied the
     * Accounts resource by design, so probing that would fail a key that can
     * hang up perfectly well.
     */
    async check(): Promise<CarrierCheck> {
      const probe = `GET ${account}/Calls.json?PageSize=1`;
      try {
        await request<unknown>(`${account}/Calls.json`, {
          method: 'GET',
          query: { PageSize: 1 },
          service: SERVICE,
        });
      } catch (err) {
        return { ok: false, probe, detail: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, probe, detail: CHECK_PASSED };
    },

    async endCall(callSid: string): Promise<void> {
      if (!callSid) {
        throw new UnsupportedCapabilityError(
          'twilio',
          'end this call',
          'no Twilio CallSid is known for this conversation; ' +
            'it comes from metadata.phone_call.call_sid on GET /v1/convai/conversations/{id}',
        );
      }
      const url = `${account}/Calls/${encodeURIComponent(callSid)}.json`;

      await requestVoid(url, {
        method: 'POST',
        form: { Status: 'completed' },
        service: SERVICE,
      });

      // Twilio answers 200 with the updated Call resource. That is an accepted
      // request, not proof the media path is torn down — say so rather than
      // reporting certainty we do not have.
      console.error(
        '[twilio] Status=completed accepted for CallSid ' +
          callSid +
          '. A 200 from Twilio means the request was accepted, not by itself proof the call dropped; ' +
          're-check with `calls.ts list --live`.',
      );
    },
  };
}

export default createTwilioCarrier;
