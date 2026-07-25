# Remove Audio (VoiceBox STT)

Idempotent — safe to run even if some steps were never applied.

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
sed -i.bak '/^VOICEBOX_URL=/d;/^VOICEBOX_STT_MODEL=/d;/^VOICEBOX_STT_LANGUAGE=/d;/^VOICEBOX_TIMEOUT_MS=/d' .env && rm -f .env.bak
```

## 4. Reset per-group opt-outs

`ncl groups list` shows the groups. For any group set to `off`, return it to the default so the setting doesn't linger as a surprise if the skill is applied again:

```bash
ncl groups config update --id <group-id> --audio-transcription on
```

Check current values with `ncl groups config get --id <group-id>`.

## 5. Remove the CA drop-in

Only if apply added one to make Node trust the VoiceBox certificate, and nothing else on this host needs it:

```bash
source setup/lib/install-slug.sh
rm -f ~/.config/systemd/user/$(systemd_unit).service.d/10-voicebox-ca.conf
systemctl --user daemon-reload
```

On macOS, delete the `NODE_EXTRA_CA_CERTS` entry from the `EnvironmentVariables` dict in `~/Library/LaunchAgents/$(launchd_label).plist`.

## 6. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

Inbound voice notes now arrive as a file path again, exactly as before the skill was applied.

## 7. (Optional) Reclaim VoiceBox disk

Whisper models are multi-GB. If nothing else on the VoiceBox server uses them, delete the ones this skill downloaded — using the **full, `whisper-` prefixed** name:

```bash
curl -fsS -X DELETE "$VOICEBOX_URL/models/whisper-turbo"
```

Existing transcripts already written into session history are left in place; they are ordinary message text now.
