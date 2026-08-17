# Reference: providers

Which speech provider this template can actually drive, what each one can do,
and what adding another involves.

## Capability matrix

| | `elevenlabs` | `openai` (Realtime) | `gemini` (Live) |
|---|---|---|---|
| Status | **implemented** | not implemented | not implemented |
| Inbound calls | `managed` — the provider answers | — | — |
| Outbound calls | yes | — | — |
| Campaigns | yes | — | — |
| Persona management | yes | — | — |
| Transcripts | yes | — | — |
| Hang-up in flight | **Twilio lines only**, via the carrier; plus the **monitor** WebSocket on enterprise | — | — |

"Inbound `managed`" matters: a NanoClaw agent container has **no public HTTP
ingress**, so nothing outside can POST into it. ElevenLabs answers inbound calls
itself and this agent learns about them by polling on a scheduled task. That is
why post-call webhooks are not usable here.

## Why OpenAI Realtime is not implemented

Accepting a call needs a **public SIP or HTTPS webhook** to receive
`realtime.call.incoming`. An agent container has no inbound ingress, so there is
nowhere for that event to land. Outbound-only support would be possible but
would ship a provider that silently cannot do the half of the job this template
exists for.

## Why Gemini Live is not implemented

There is **no first-party PSTN**. Gemini Live is an audio API, not a phone
service, so it needs a media bridge — something that terminates a phone call and
pumps audio both ways — which is a service to run, not an adapter to write.

## No stub files ship

There are no empty `providers/openai/` or `providers/gemini/` directories. Both
names are **registered** in `tools/lib/registry.ts`, and asking for either
raises a `ProviderNotAvailableError` stating exactly what is missing and
pointing back at this file. A named refusal is more useful than a directory that
looks half-finished.

Selecting a provider that is not registered at all fails the same way, loudly.

## Adding a provider

It is a subclass, not a rewrite. `tools/lib/provider.ts` holds the abstract
`VoiceProvider`; every domain type crossing that boundary is provider-neutral,
so no wire vocabulary from one provider leaks into the tools (a `Line` carries
`id`, never `phone_number_id`).

1. **Write `tools/providers/<name>/provider.ts`** extending `VoiceProvider`.
   Implement the ten abstract methods: `listLines`, `assignLine`,
   `listPersonas`, `getPersona`, `createPersona`, `updatePersona`, `placeCall`,
   `listCalls`, `getCall`, `hangUp`. Keep the wire shapes in a sibling
   `types.ts` and the REST calls in a sibling `client.ts`.
2. **Optionally implement the three campaign methods** —
   `submitCampaign`, `getCampaign`, `cancelCampaign`. They are optional on the
   contract; omit them and `campaign.ts` reports a named
   `UnsupportedCapabilityError` instead of crashing.
3. **Declare honest capabilities.** `capabilities.hangUp` is the list of
   strategies that actually work on this install, and an empty array is a valid,
   useful answer. Anything the provider cannot do calls `this.unsupported(...)`,
   which produces a named refusal.
4. **Register it in `tools/lib/registry.ts`.**
5. **Send no auth header.** `lib/http.ts` deliberately sets none — the OneCLI
   gateway injects by destination host. Add the new host's vault recipe to
   `connect-provider.md`.

The five CLI tools need no changes: they only ever talk to the abstract
contract.

## Carriers are orthogonal

`tools/carriers/` is about the **phone network**, not the speech provider —
Twilio, Exotel, or a SIP trunk vendor. **Only Twilio has a hang-up adapter here**;
the other two are detected and dialable but cannot be ended in flight, because
neither route was ever confirmed against a live account. A future OpenAI-over-SIP
provider would reuse those adapters unchanged, which is why hang-up lives there and not inside
`providers/elevenlabs/`. See `ending-a-call.md` for what each carrier can and
cannot do.
