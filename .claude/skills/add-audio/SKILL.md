---
name: add-audio
description: Let agents hear voice notes. Transcribes inbound audio from every channel via a self-hosted VoiceBox STT server, and stores the text in the session's conversation history so the agent can recall what was said weeks later. Triggers on "add audio", "voice notes", "transcribe audio", "speech to text", "STT".
---

# Add Audio (VoiceBox STT)

Agents receive voice notes as a file path they cannot hear. This skill turns them into text.

Inbound audio from **any** channel — WhatsApp voice notes, Telegram voice, Slack/Discord audio attachments — is transcribed on the host at ingest and the transcript is written into the session's `inbound.db` alongside the message. Because that DB *is* the durable conversation history replayed into every prompt, the agent both reads the words now and remembers them indefinitely. The audio file is kept on disk, so nothing is lost if a transcription is wrong.

**Hard dependency:** a reachable [VoiceBox](https://voicebox.yanays.lan) server. This skill cannot proceed without one.

## How it works

```
inbound audio (any channel)
  └─ router deliverToAgent()
      ├─ audio transcriber seam        ← src/modules/audio/, wired by this skill
      │    per-group on/off → VoiceBox POST /transcribe
      └─ writeSessionMessage → inbound.db   transcript persisted
           └─ container formatter renders the spoken text into every prompt
```

Transcription is per-agent-group and defaults to **on** for every group. The transcriber is a passthrough until `VOICEBOX_URL` is set, so applying the code changes alone changes nothing.

---

## Phase 1: VoiceBox URL

Ask the user for their VoiceBox base URL. Do not guess it and do not proceed without it:

> What's your VoiceBox URL? (e.g. `https://voicebox.example.lan` — include the scheme, no trailing slash)

Probe it:

```bash
curl -fsS --max-time 10 "$VOICEBOX_URL/health"
```

Expected: JSON with `"status": "healthy"`.

If this fails, **stop**. Report the exact curl error to the user and ask them to confirm the server is running and reachable from this host. Everything downstream depends on it.

Read `gpu_available` from the response and tell the user what it means for them:

- `"gpu_available": true` — transcription is fast; the default timeout is ample.
- `"gpu_available": false` — the server is CPU-only. Short voice notes are fine; a multi-minute note may exceed the 60s default and fall back to delivering the audio untranscribed. `VOICEBOX_TIMEOUT_MS` raises the ceiling.

Write the URL to `.env`:

```bash
grep -q '^VOICEBOX_URL=' .env \
  && sed -i.bak "s|^VOICEBOX_URL=.*|VOICEBOX_URL=$VOICEBOX_URL|" .env && rm -f .env.bak \
  || echo "VOICEBOX_URL=$VOICEBOX_URL" >> .env
```

### Confirm Node trusts the certificate

A passing `curl` is **not** sufficient evidence. `curl` uses the system CA store; the NanoClaw host is Node, which ships its own CA bundle and rejects certificates the system trusts. A self-hosted VoiceBox behind an internal or self-signed CA fails in Node while `curl` succeeds. Test with the runtime that actually matters:

```bash
node -e "fetch('$VOICEBOX_URL/health').then(r=>r.json()).then(()=>console.log('node: OK')).catch(e=>console.log('node: FAIL', e.cause?.code||e))"
```

`node: OK` — skip to Phase 2.

`node: FAIL SELF_SIGNED_CERT_IN_CHAIN` (or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) — Node needs to be pointed at the CA that signed the certificate. Confirm the system bundle covers it:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  node -e "fetch('$VOICEBOX_URL/health').then(()=>console.log('with CA bundle: OK')).catch(e=>console.log('still failing:', e.cause?.code||e))"
```

If that prints OK, set it on the **service**, not in `.env` — `.env` is read into the app's own config object and never reaches `process.env`, and Node reads `NODE_EXTRA_CA_CERTS` once at startup:

```bash
source setup/lib/install-slug.sh

# Linux (systemd drop-in)
mkdir -p ~/.config/systemd/user/$(systemd_unit).service.d
cat > ~/.config/systemd/user/$(systemd_unit).service.d/10-voicebox-ca.conf <<'EOF'
[Service]
Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
EOF
systemctl --user daemon-reload

# macOS: add NODE_EXTRA_CA_CERTS to the <key>EnvironmentVariables</key> dict
# in ~/Library/LaunchAgents/$(launchd_label).plist
```

If the system bundle does *not* cover it, ask the user for the path to their CA certificate and use that path instead. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` — it disables certificate verification for every outbound connection the host makes, including the Anthropic API.

## Phase 2: List the STT models

```bash
curl -fsS "$VOICEBOX_URL/models/status"
```

This returns **every** model the server knows about, text-to-speech and speech-to-text mixed together. The STT models are exactly those whose `model_name` begins with `whisper-`. Filter to those and show the user `display_name`, `downloaded`, and `size_mb`:

```bash
curl -fsS "$VOICEBOX_URL/models/status" | python3 -c "
import json,sys
for m in json.load(sys.stdin)['models']:
    if m['model_name'].startswith('whisper-'):
        mb = f\"{m['size_mb']:.0f}MB\" if m.get('size_mb') else '-'
        print(f\"{m['model_name']:24} {'downloaded' if m['downloaded'] else 'not downloaded':16} {mb:>8}  {m['display_name']}\")
"
```

## Phase 3: Download a model if none is present

If at least one `whisper-*` model shows `downloaded: true`, ask the user which one to use and skip to Phase 4.

If none is downloaded, present the list and ask which to download. Guidance to offer:

- `whisper-turbo` — best general-purpose default: fast, multilingual, good accuracy.
- `whisper-base` / `whisper-small` — smallest and quickest; use when the server is CPU-only and speed matters more than accuracy.
- `whisper-large` — highest accuracy, slowest; painful on a CPU-only server.
- `whisper-ivrit-turbo` / `whisper-ivrit-large` — Hebrew-specialized. Recommend these if the user's voice notes are mainly in Hebrew.

Download with the **full, `whisper-` prefixed** name:

```bash
curl -fsS -X POST "$VOICEBOX_URL/models/download" \
  -H 'Content-Type: application/json' \
  -d '{"model_name": "whisper-turbo"}'
```

Poll until it lands (downloads are multi-GB; this can take a while):

```bash
curl -fsS "$VOICEBOX_URL/models/status" | python3 -c "
import json,sys
m = next(x for x in json.load(sys.stdin)['models'] if x['model_name']=='whisper-turbo')
print('downloaded' if m['downloaded'] else ('downloading' if m['downloading'] else 'not started'))
"
```

### Record the chosen model — in bare form

The two endpoints disagree about naming, and getting this wrong produces an HTTP 400 on every single voice note:

| Endpoint | Form | Example |
|---|---|---|
| `/models/status`, `/models/download` | **prefixed** | `whisper-ivrit-turbo` |
| `/transcribe` | **bare** | `ivrit-turbo` |

`VOICEBOX_STT_MODEL` is consumed by `/transcribe`, so strip the `whisper-` prefix before writing it:

```bash
STT_MODEL="${CHOSEN_MODEL#whisper-}"   # whisper-ivrit-turbo -> ivrit-turbo
grep -q '^VOICEBOX_STT_MODEL=' .env \
  && sed -i.bak "s|^VOICEBOX_STT_MODEL=.*|VOICEBOX_STT_MODEL=$STT_MODEL|" .env && rm -f .env.bak \
  || echo "VOICEBOX_STT_MODEL=$STT_MODEL" >> .env
```

Confirm the pairing works end to end before going further:

```bash
python3 -c "
import struct,math,wave
w=wave.open('/tmp/vb-probe.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b''.join(struct.pack('<h',int(3000*math.sin(2*math.pi*220*i/16000))) for i in range(16000)))
w.close()"
curl -sS -w '\nHTTP %{http_code}\n' -F file=@/tmp/vb-probe.wav -F "model=$STT_MODEL" "$VOICEBOX_URL/transcribe"
rm -f /tmp/vb-probe.wav
```

HTTP 200 with a `{"text": ..., "duration": ...}` body means the model name is right. An HTTP 400 saying `Invalid model size` means the `whisper-` prefix survived — strip it and retry.

## Phase 4: Language

Ask whether the user's voice notes are predominantly one language. Supported values: `en zh ja ko de fr ru pt es it he`.

- One dominant language → set it; pinning improves accuracy and speed.
- Mixed or unsure → leave unset for auto-detection.

```bash
echo "VOICEBOX_STT_LANGUAGE=he" >> .env      # only when the user picks one
```

Optionally raise the per-transcription timeout from its 60000ms default (worth doing on a CPU-only server):

```bash
echo "VOICEBOX_TIMEOUT_MS=120000" >> .env
```

## Phase 5: Wire the module

Register the transcriber by appending its import to the modules barrel. Check first — this is idempotent:

```bash
grep -q "audio/index.js" src/modules/index.ts || \
  echo "import './audio/index.js';" >> src/modules/index.ts
```

Copy in the test that guards this wiring:

```bash
cp .claude/skills/add-audio/registration.test.ts src/modules/audio/registration.test.ts
```

Build (this also runs the DB migration that adds the per-group column on next start):

```bash
pnpm run build
```

## Phase 6: Choose which agents listen

Every agent group is enabled by default. Show the user their groups and ask whether any should be excluded:

```bash
ncl groups list
```

For each group the user wants to opt **out**:

```bash
ncl groups config update --id <group-id> --audio-transcription off
```

To re-enable later, the same command with `--audio-transcription on`. Verify what a group is set to with `ncl groups config get --id <group-id>`.

## Phase 7: Restart and verify

```bash
pnpm test -- src/modules/audio/
```

All tests must pass — they are the verification that the wiring is live, not a separate check.

Restart the service. The unit name carries this install's slug, so resolve it rather than hardcoding it:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

Then have the user send a voice note to a wired agent. Confirm the transcript reached durable history:

```bash
pnpm exec tsx scripts/q.ts data/v2-sessions/<agent-group>/<session>/inbound.db \
  "SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1"
```

The attachment object should carry both `localPath` and `transcript`, and the agent's reply should address what was *said* rather than announcing that it received an audio file.

---

## Troubleshooting

**Agent replies "I received an audio file" and nothing else.** The transcript never landed. Check `logs/nanoclaw.error.log` for a warning from the audio module. Most likely `VOICEBOX_URL` is unset or unreachable from the host — re-run the Phase 1 probe.

**Every voice note logs HTTP 400 `Invalid model size`.** `VOICEBOX_STT_MODEL` still carries the `whisper-` prefix. `/transcribe` wants the bare size. Fix the `.env` value and restart.

**`curl` reaches VoiceBox but the host logs a TLS error** (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`). `curl` and Node use different CA stores; a cert your system trusts is not automatically one Node trusts. Re-run the Node probe in Phase 1 and set `NODE_EXTRA_CA_CERTS` on the service.

**Transcripts are empty or nonsense.** Usually a language mismatch — a Hebrew note through an English-only model returns plausible-sounding garbage. Set `VOICEBOX_STT_LANGUAGE`, or switch to a model matched to the language (`whisper-ivrit-turbo` for Hebrew). The original audio is still in `inbox/<msgId>/` inside the session folder, so you can re-run it by hand against a different model.

**Long voice notes work, short ones don't — or vice versa.** Check `gpu_available` in `/health`. On a CPU-only server, transcription time scales with audio length; anything past `VOICEBOX_TIMEOUT_MS` falls back to delivering the audio untranscribed. Raise the timeout.

**Nothing changed after applying.** Confirm the barrel line landed: `grep audio/index.ts src/modules/index.ts`. Then confirm the service actually restarted — the module registers at process start, so an un-restarted host still runs the old code.

**One group transcribes and another doesn't.** That is the per-group switch working. Check with `ncl groups config get --id <group-id>` and look at `audio_transcription`.

## Notes

- Attachments that arrive as a URL rather than inline bytes are skipped rather than fetched, so the host never issues outbound requests on behalf of an untrusted sender. This is logged at `warn`.
- One inbound message fanned out to several agent groups is transcribed once, not once per group.
- A transcription failure never drops or delays a message beyond its own timeout — the message routes with the audio attached, exactly as it would without this skill.
- Removal: see [REMOVE.md](REMOVE.md).
