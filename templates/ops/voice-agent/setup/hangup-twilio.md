# Setup 5 — hang-up on a Twilio line (optional)

Skip this whole file unless the operator wants to **end a call in flight**.
Dialing, answering, campaigns, transcripts and every report work with the
ElevenLabs key alone. This buys hang-up and nothing else.

Skip it too if the number from `phone-number.md` is on **Exotel or a SIP
trunk**: there is no hang-up adapter for either here, so there is nothing a
credential could unlock. Walking an operator through a vault entry for
`api.exotel.com` or a trunk vendor's host would cost them a key and buy nothing.
Say that plainly and move on — `skills/voice-line/references/ending-a-call.md`
has what the agent offers instead.

## 1. An API key, not the Auth Token

Twilio's REST API takes HTTP Basic and accepts either pair, which is exactly why
this needs saying: the **Auth Token is the account's root credential**. It
cannot be scoped, and rotating it breaks every other integration on that account
at the same moment. An API key is revocable on its own.

Operator, in the Twilio console → **Account → API keys & tokens → Create API
key**. That hands back two values; a third they already have.

| Value | Looks like | Where it goes |
|---|---|---|
| API Key **SID** | `SK…` | the vault, as the Basic **username** |
| API Key **Secret** | long random string, **shown once** | the vault, as the Basic **password** |
| Account **SID** | `AC…` | `config.json` — it stays in the request URL |

Key type: **Standard** is right — it reaches every API resource except
*Accounts* and *Keys*, which this template never touches. **Main** works but is
over-privileged. **Restricted** is the tightest option and needs **Voice →
Calls** with **read and write**: write for the hang-up itself, read so the
verification below can prove the key without placing a call.

## 2. The vault entry

Hand the operator this, to run **in their own terminal**:

```bash
TWILIO_BASIC=$(printf '%s:%s' "$SK_SID" "$SK_SECRET" | base64 | tr -d '\n')

onecli secrets create \
  --name "Twilio" \
  --type generic \
  --value "$TWILIO_BASIC" \
  --host-pattern "api.twilio.com" \
  --header-name "Authorization" \
  --value-format "Basic {value}"
```

**`| tr -d '\n'` is not optional.** GNU coreutils `base64` wraps at 76 columns,
and an `SK…` SID plus a secret encodes to roughly 92 characters — so a bare
`| base64` puts a **newline in the middle of the header value**. The vault
stores it, the gateway sends it, and Twilio answers 401, indistinguishable from
a wrong key. (`base64 -w 0` does the same job on Linux but is rejected on macOS;
`tr` works on both.)

Two more ways to get a 401 that reads as "bad key":

- **The `SK…` SID goes on the left of the colon**, not the `AC…` Account SID.
  The Account SID is the *account*, not the *caller*; it belongs in the URL.
- **The key must belong to the same account as that Account SID.** A valid key
  from another account or subaccount is still a 401 here.

## 3. The Account SID — an identifier, on disk

The `AC…` Account SID appears in the request URL path. It says which account the
call belongs to, not who is asking, so it is not a secret and it does not go in
the vault. It lives in the group's workspace:

```
groups/<folder>/voice-line/config.json     →  /workspace/agent/voice-line/config.json
```

Seed it here, before the container has ever run:

```bash
mkdir -p groups/<folder>/voice-line
```

Then write `config.json` with the Account SID under `twilio.accountSid`,
creating the file if it does not exist and **merging** into it if it does:

```json
{
  "provider": "elevenlabs",
  "lines": {},
  "twilio": { "accountSid": "AC…" },
  "updatedAt": 0
}
```

This host-side seed is a one-time setup step and the only hand-write this file
ever gets. **Inside the container the tools own it** — `lines.ts carrier
--twilio-sid <AccountSid>` is how it changes from then on, and the config writer
refuses any credential-shaped key a second time. The agent is told never to edit
it by hand; do not leave it an example to the contrary by putting anything else
in there.

If the operator would rather not touch JSON: skip this step, and after wiring
tell the agent once — "our Twilio Account SID is `AC…`, record it and check the
carrier". An `AC…` in chat is an identifier, not a leak. The key never is.

## 4. Verify the vault half

The same `onecli run` route as the ElevenLabs check, against the endpoint the
hang-up actually uses:

```bash
onecli run --agent <agent-id> -- curl -s -o /dev/null -w '%{http_code}\n' \
  "https://api.twilio.com/2010-04-01/Accounts/<AccountSid>/Calls.json?PageSize=1"
```

`200` means the vault entry reaches Twilio and Twilio accepts it for this
account. `401` sends you back to step 2 — in practice, to the newline.

The agent proves the same thing from its side with one command, and should be
asked to run it at first contact rather than at the moment someone wants a call
stopped:

```bash
bun /workspace/agent/plugins/voice-agent/tools/lines.ts carrier --check
```

**A `pass` is a narrow claim.** It proves the key is valid for this account and
can **read** its calls. It does not prove the key can **update** one (a
Restricted key can be granted read without write), and it says nothing about
whether any particular call will drop. Report it that way; do not let `pass`
become "hang-up works".

## Teardown

Because this is an **API key** and not the Auth Token, revoking it is contained:
Twilio console → API keys & tokens → delete that key, and nothing else on the
account notices. Deleting the vault entry alone leaves the key live and
billable at Twilio, same as with ElevenLabs.
