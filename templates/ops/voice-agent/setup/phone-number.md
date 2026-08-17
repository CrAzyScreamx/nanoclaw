# Setup 4 — the phone number

The number is imported by the **operator**, in the ElevenLabs dashboard. Not by
you on the host, and not by the agent in the container.

The reason is not policy. `POST /v1/convai/phone-numbers` takes a raw carrier
Account SID **and Auth Token** in its JSON body — the account's root credential,
the one that cannot be scoped and whose rotation breaks every other integration
the operator has. Routing that through a chat, a shell history or a file in a
container is not something a vault entry can fix, because the vault rewrites
headers on outbound HTTPS and these values ride inside a body. So the dashboard
is the only safe place for it, and the template refuses the alternatives rather
than offering a worse one.

## 1. The carrier account comes first

The operator buys the number from a carrier, and that carrier bills them
directly — separately from ElevenLabs. Which carrier they pick is a decision
with one consequence worth naming **before** they buy:

| Carrier | Dials, answers, reports | Ends a call in flight |
|---|---|---|
| **Twilio** | yes | **yes** — the only hang-up adapter this template ships |
| Exotel | yes | no adapter here |
| SIP trunk | yes | no adapter here |

Neither of the other two was ever confirmed against a live account — Exotel's
Legs API lookup was unverified, and there is no generic SIP hang-up at all,
since ElevenLabs ends a SIP call with a `BYE` that nothing in a container can
send. An unverified hang-up is worse than none: it fails as a call that keeps
running while the agent reports success. Both may return once someone tests them
for real.

So: **if the operator wants "hang up this call now", the number has to be on
Twilio**, and that is easiest to arrange before the number exists. If they do
not need it, any of the three is fine and the persona's `end_call` tool — which
works on every carrier and every plan — covers the ordinary case of a call that
should end when it is finished.

## 2. Import it

Operator, in the ElevenLabs dashboard → **Phone Numbers** → add the number with:

- a **label** (this is what the agent will call the line in chat — make it read
  like the line's job: "Front desk", "Support callback");
- the **number** itself;
- the carrier **SID + token**;
- optionally, an agent to answer it — the persona can be assigned later from
  chat, which is the part that genuinely belongs there.

## 3. SIP trunk only: the digest credentials stay in the dashboard

Trunk digest username and password are set in the ElevenLabs dashboard and
nowhere else, for the same structural reason as the import: they travel in a
JSON body, so there is no header for the gateway to inject them into, and
anywhere else in the container means plaintext on disk.

`lines.ts` and `personas.ts` refuse any flag that looks like trunk configuration
or a digest credential. That refusal is a design decision, not a missing
feature — when the agent hits it in chat, it hands the user this dashboard step
instead of trying another flag spelling.

## 4. Leave the check to first contact

There is no host-side command that lists the lines — `lines.ts` runs in the
container. That is fine: the **welcome** skill's first act is
`lines.ts list`, which reports every number, its label, its carrier and who
answers it, and records the carrier for every later hang-up decision.

If the import did not take, that read-only call is where it surfaces, in the
first minute of the first conversation, with the number missing from a list the
operator is reading anyway.
