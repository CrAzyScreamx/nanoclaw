# Remove Audio (VoiceBox)

Idempotent — safe to run even if some steps were never applied.

Section 5 is the only voice-reply section; 1–4 and 6 are transcription, and 7–8 apply to
both. To remove one direction and keep the other, run only its sections — they share
nothing but the VoiceBox server itself.

Reverses what apply added: the barrel registration, the copied test, the `.env` keys, and any per-group opt-outs. The transcriber module, the `audio_transcription` column, and the `ncl` flag ship with the project rather than with this skill, so they stay; with the barrel line gone nothing registers and the seam is inert.

## 1. Unregister the module

Delete the line from `src/modules/index.ts` (delete it — do not comment it out):

```bash
grep -v "audio/index.js" src/modules/index.ts > src/modules/index.ts.tmp \
  && mv src/modules/index.ts.tmp src/modules/index.ts
```

## 2. Delete the copied test

```bash
rm -f src/modules/audio/registration.test.ts
```

## 3. Remove the `.env` keys

```bash
sed -i.bak '/^VOICEBOX_URL=/d;/^VOICEBOX_STT_MODEL=/d;/^VOICEBOX_STT_LANGUAGE=/d;/^VOICEBOX_STT_FALLBACK_MODEL=/d;/^VOICEBOX_TIMEOUT_MS=/d' .env && rm -f .env.bak
```

## 4. Reset per-group opt-outs

`ncl groups list` shows the groups. For any group set to `off`, return it to the default so the setting doesn't linger as a surprise if the skill is applied again:

```bash
ncl groups config update --id <group-id> --audio-transcription on
```

Check current values with `ncl groups config get --id <group-id>`.

## 5. Remove voice replies

Delete the container skill, so no group loads it on the next spawn:

```bash
rm -rf container/skills/voice-reply
```

Delete the per-group settings, the certificate copies, and the standing instruction. Run
this over every group folder — groups that never spoke have nothing to delete:

```bash
for d in groups/*/; do
  rm -f "$d/voice-reply.json" "$d/voicebox-ca.crt"
  if [ -f "$d/instructions.prepend.md" ]; then
    grep -v -e 'voice-reply' -e 'Answer this chat by voice' -e 'spoken version instead of a text message' \
      -e 'Reply in text only when the content cannot be' -e 'spoken — code, tables, links — or when voice generation fails' \
      "$d/instructions.prepend.md" > "$d/.ipm.tmp" && mv "$d/.ipm.tmp" "$d/instructions.prepend.md"
  fi
done
```

Read back each `instructions.prepend.md` that had the block and tidy any blank line left
behind — the persona file is prose the agent reads every turn, not a config file.

Drop `voice-reply` from any `container.json` that names skills explicitly:

```bash
python3 -c "
import json,glob
for p in glob.glob('groups/*/container.json'):
    c=json.load(open(p))
    if isinstance(c.get('skills'),list) and 'voice-reply' in c['skills']:
        c['skills']=[s for s in c['skills'] if s!='voice-reply']
        json.dump(c,open(p,'w'),indent=2); print('cleaned',p)
"
```

## 6. Remove the CA drop-in

Only if apply added one to make Node trust the VoiceBox certificate, and nothing else on this host needs it:

```bash
source setup/lib/install-slug.sh
rm -f ~/.config/systemd/user/$(systemd_unit).service.d/10-voicebox-ca.conf
systemctl --user daemon-reload
```

On macOS, delete the `NODE_EXTRA_CA_CERTS` entry from the `EnvironmentVariables` dict in `~/Library/LaunchAgents/$(launchd_label).plist`.

## 7. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

Inbound voice notes now arrive as a file path again, exactly as before the skill was applied.

## 8. (Optional) Reclaim VoiceBox disk

Models are multi-GB. If nothing else on the VoiceBox server uses them, delete the ones this skill downloaded — transcription models by their **full, `whisper-` prefixed** name, TTS models by the name shown in `/models/status`. Count two of each if an English fallback engine and fallback voice were configured:

```bash
curl -fsS -X DELETE "$VOICEBOX_URL/models/whisper-ivrit-turbo"   # primary STT
curl -fsS -X DELETE "$VOICEBOX_URL/models/whisper-turbo"         # fallback STT, if any
curl -fsS -X DELETE "$VOICEBOX_URL/models/phonikud-he"           # primary TTS
curl -fsS -X DELETE "$VOICEBOX_URL/models/kokoro"                # fallback TTS, if any
```

Those names are examples — check `.env` and each `voice-reply.json` for what this install actually chose before deleting anything.

Existing transcripts already written into session history are left in place; they are ordinary message text now.
