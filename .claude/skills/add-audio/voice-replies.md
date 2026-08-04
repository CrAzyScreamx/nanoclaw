# Voice replies (VoiceBox TTS)

The outbound half: an agent answers with a spoken voice note instead of text. The words go
to VoiceBox `/generate/stream`, the WAV comes back, `/convert` turns it into Ogg/Opus, and
`send_file` delivers it to the chat.

Everything here runs **after** Phase 1 of [SKILL.md](SKILL.md) — the VoiceBox URL is probed
and reachable. Nothing here depends on transcription being enabled.

```
agent composes a reply
  └─ voice-reply container skill        ← container/skills/, installed here
       ├─ POST /generate/stream  → speech.wav      primary voice, or the
       │                                           English fallback voice
       ├─ POST /convert  format=ogg → speech.ogg
       └─ send_file → outbox/ → host adapter → chat
```

Per-group settings live in `groups/<folder>/voice-reply.json`. A group without that file
never speaks, even though the skill is present in its container — which is what keeps this
safe under the default `skills: 'all'` selection.

A group can carry two voices: the primary one it normally speaks in, and an optional
English fallback for replies the primary voice can't carry — a language it doesn't speak, or
a user asking for English. Steps 2–4 pick the primary, Step 5 offers the fallback.

---

## Step 1: Offer it

> Voice replies: the agent can answer with a spoken voice note instead of text. Enable it?

Stop here if they decline. Nothing so far is installed.

## Step 2: Pick the TTS model

`/models/status` returns speech-to-text, text-to-speech, and chat models in one list.
The TTS models are the entries below and nothing else — `whisper-*` transcribe, and
`qwen3-*` are chat models. Watch the near-collision: **`qwen-tts-*` is TTS, `qwen3-*` is
not**, so filter by this table rather than by prefix.

| Model | `engine` | `model_size` | Notes |
|---|---|---|---|
| `kokoro` | `kokoro` | — | 82M, English preset voices. Fast on CPU. |
| `phonikud-he` | `phonikud` | — | Hebrew preset voices. Fast on CPU. |
| `luxtts` | `luxtts` | — | Cloning, CPU-friendly. |
| `chatterbox-tts` | `chatterbox` | — | Cloning, multilingual. |
| `chatterbox-turbo` | `chatterbox_turbo` | — | Cloning, English, supports tags. |
| `tada-1b` | `tada` | `1B` | Cloning, English. |
| `tada-3b-ml` | `tada` | `3B` | Cloning, multilingual. |
| `qwen-tts-1.7B` | `qwen` | `1.7B` | Cloning, highest quality, heaviest. |
| `qwen-tts-0.6B` | `qwen` | `0.6B` | Cloning, lighter Qwen. |
| `qwen-custom-voice-1.7B` | `qwen_custom_voice` | `1.7B` | Preset Qwen voices. |
| `qwen-custom-voice-0.6B` | `qwen_custom_voice` | `0.6B` | Preset Qwen voices. |

Show which of them the server actually has:

```bash
curl -fsS "$VOICEBOX_URL/models/status" | python3 -c "
import json,sys
TTS = {'kokoro','phonikud-he','luxtts','chatterbox-tts','chatterbox-turbo','tada-1b',
       'tada-3b-ml','qwen-tts-1.7B','qwen-tts-0.6B','qwen-custom-voice-1.7B','qwen-custom-voice-0.6B'}
for m in json.load(sys.stdin)['models']:
    if m['model_name'] in TTS:
        print(f\"{m['model_name']:24} {'downloaded' if m['downloaded'] else 'NOT downloaded':16} {m['display_name']}\")
"
```

Ask which one to use, and steer toward a **downloaded** one — a first synthesis on a
missing model returns HTTP 400, it does not download on demand. Recommend by the language
they will speak: `phonikud-he` for Hebrew, `kokoro` for English. Both are small and run
acceptably on a CPU-only server, which matters because every reply pays this cost.

To download one, use the model name from the table and poll until it lands:

```bash
curl -fsS -X POST "$VOICEBOX_URL/models/download" \
  -H 'Content-Type: application/json' -d '{"model_name": "kokoro"}'
curl -fsS "$VOICEBOX_URL/models/status" | python3 -c "
import json,sys
m = next(x for x in json.load(sys.stdin)['models'] if x['model_name']=='kokoro')
print('downloaded' if m['downloaded'] else ('downloading' if m['downloading'] else 'not started'))
"
```

Record `ENGINE` and `MODEL_SIZE` from the table row they chose. `MODEL_SIZE` is empty for
every model whose column shows `—`.

## Step 3: Language

Ask which language the agent should speak. It is independent of the language users write
in, and of the STT language: an agent can read Hebrew and answer in English.

Accepted codes: `zh en ja ko de fr ru pt es it he ar da el fi hi ms nl no pl sv sw tr`.

The engine has to be able to produce it — `kokoro` is English, `phonikud` is Hebrew,
`chatterbox` / `tada-3b-ml` / `qwen*` are multilingual. If their answer contradicts the
model from Step 2, go back to Step 2 rather than writing a pairing that produces garbage.
Record `LANGUAGE`.

## Step 4: Pick the voice profile

A profile is the voice itself. List them with the engine each one is locked to:

```bash
curl -fsS "$VOICEBOX_URL/profiles" | python3 -c "
import json,sys
for p in json.load(sys.stdin):
    lock = p.get('preset_engine') if p.get('voice_type')=='preset' else 'any cloning engine'
    print(f\"{p['id']}  {p['name'][:28]:30} {p['language']:4} {p['voice_type']:9} engine: {lock}\")
"
```

**Show only the profiles compatible with the engine from Step 2**, because a mismatch is a
hard 400 on every single reply:

- `voice_type: preset` — works **only** with its own `preset_engine`.
- `voice_type: cloned` — works with `qwen`, `luxtts`, `chatterbox`, `chatterbox_turbo`, `tada`.
- `voice_type: designed` — works with any engine.

If nothing is compatible, say so and return to Step 2 — the engine is what has to move.
Record `PROFILE_ID`.

Prove the pairing before wiring anything to it:

```bash
curl -sS --fail-with-body -X POST "$VOICEBOX_URL/generate/stream" \
  -H 'Content-Type: application/json' \
  -d "{\"profile_id\":\"$PROFILE_ID\",\"text\":\"Voice check.\",\"language\":\"$LANGUAGE\",\"engine\":\"$ENGINE\"}" \
  -o /tmp/vb-tts-probe.wav
curl -sS --fail-with-body -X POST "$VOICEBOX_URL/convert" \
  -F file=@/tmp/vb-tts-probe.wav -F format=ogg -o /tmp/vb-tts-probe.ogg
head -c 4 /tmp/vb-tts-probe.ogg; echo; ls -l /tmp/vb-tts-probe.ogg
rm -f /tmp/vb-tts-probe.wav /tmp/vb-tts-probe.ogg
```

`OggS` and a file of a few tens of KB means the whole chain works. `only supports engine`
means the profile and engine disagree — fix that here, not later.

## Step 5: Offer the English fallback voice

> Fallback voice: if the agent has to answer in a language this voice can't speak — or you
> ask it to answer in English — it can switch to a second, English voice instead of dropping
> to text. Add one?

Skip the offer entirely when `LANGUAGE` from Step 3 is already `en`; the primary voice is
the English voice. If they decline, `fallback` stays `null` in Step 8 and the agent answers
in text whenever its voice doesn't fit — which is a fine answer, not a failure.

The fallback is **English-only by design**. It is not a second general voice: it is the one
voice the agent falls back to when the reply cannot be spoken in `LANGUAGE`.

Choose it under the same constraint as Step 4 — a preset profile only works with its own
`preset_engine` — so re-read the `/profiles` listing from there and pick an `en` profile:

- The primary engine may not speak English at all (`phonikud` is Hebrew-only). Then the
  fallback needs a **different engine** as well — `kokoro` is the cheap English default.
- A multilingual cloning engine (`chatterbox`, `tada-3b-ml`, `qwen*`) can usually keep its
  engine and change only the profile.

Whichever it is, the fallback model has to be downloaded too — a missing one is a 400 on
every fallback attempt, at the exact moment the primary already couldn't answer.

Prove the fallback pairing on its own, the same way Step 4 proved the primary:

```bash
curl -sS --fail-with-body -X POST "$VOICEBOX_URL/generate/stream" \
  -H 'Content-Type: application/json' \
  -d "{\"profile_id\":\"$FALLBACK_PROFILE_ID\",\"text\":\"Fallback voice check.\",\"language\":\"en\",\"engine\":\"$FALLBACK_ENGINE\"}" \
  -o /tmp/vb-fb-probe.wav
head -c 4 /tmp/vb-fb-probe.wav; echo; ls -l /tmp/vb-fb-probe.wav
rm -f /tmp/vb-fb-probe.wav
```

`RIFF` and a non-trivial file size means it works. Record `FALLBACK_PROFILE_ID`,
`FALLBACK_ENGINE`, and `FALLBACK_MODEL_SIZE` (empty unless the table row in Step 2 shows a
`model_size`).

## Step 6: Install the container skill

Copy the skill the agents run:

```bash
rsync -a .claude/skills/add-audio/container-skills/ container/skills/
```

The default `skills: 'all'` selection re-reads `container/skills/` at every spawn, so this
reaches every group on that selection with no further wiring. Groups with an explicit
`skills` array need `voice-reply` added to it — Step 8 covers that.

Confirm it landed:

```bash
test -f container/skills/voice-reply/SKILL.md && echo INSTALLED
```

### Certificate trust inside the container

The host trusting the VoiceBox certificate says nothing about the container: it has its own
CA bundle, and a self-hosted or internal CA is absent from it. Test in a real agent image
rather than assuming — a fresh container is the only honest test:

```bash
IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw-agent | head -1)
docker run --rm --network nanoclaw-net --entrypoint bash "$IMAGE" -c \
  "curl -sS --noproxy '*' --max-time 15 -o /dev/null -w 'container: HTTP %{http_code}\n' $VOICEBOX_URL/health"
```

`HTTP 200` — the container trusts it. `CACERT` is empty; skip to Step 7.

`curl: (60) SSL certificate problem` — give each speaking group the certificate chain. The
group folder is mounted at `/workspace/agent`, so a file dropped there is readable by the
agent and survives respawns. Run this per group folder from Step 8:

```bash
HOST=$(echo "$VOICEBOX_URL" | sed -E 's|^https?://||; s|/.*||')
openssl s_client -showcerts -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > groups/<folder>/voicebox-ca.crt
grep -c 'BEGIN CERTIFICATE' groups/<folder>/voicebox-ca.crt
```

Two or more certificates means the server sent its chain. Set `CACERT` to
`/workspace/agent/voicebox-ca.crt` and re-run the container probe with
`--cacert /workspace/agent/voicebox-ca.crt` and `-v $PWD/groups/<folder>/voicebox-ca.crt:/workspace/agent/voicebox-ca.crt:ro`
to confirm 200. Do not fall back to `-k`; it turns off verification for every request the
agent makes.

If the count is `0`, the server did not present its chain — ask the user for their CA
certificate file and copy that in instead.

## Step 7: Choose which agents speak, and when

```bash
ncl groups list
```

Ask which groups get voice replies, and **for each one** how it should behave:

- **`always`** — every reply to that chat goes out as a voice note. Fits a personal DM.
- **`on-request`** — text by default; voice when the user asks for it ("send me a voice
  note", "say it out loud"). Fits busy or shared group chats, where unprompted audio is
  intrusive and slower to consume than text.

## Step 8: Write the per-group settings

For each chosen group, using its `folder` from `ncl groups list`:

```bash
# Null unless Step 2 / Step 5 / Step 6 gave them a value.
MODEL_SIZE_JSON=$([ -n "$MODEL_SIZE" ] && echo "\"$MODEL_SIZE\"" || echo null)
CACERT_JSON=$([ -n "$CACERT" ] && echo "\"$CACERT\"" || echo null)
FB_SIZE_JSON=$([ -n "$FALLBACK_MODEL_SIZE" ] && echo "\"$FALLBACK_MODEL_SIZE\"" || echo null)

if [ -n "$FALLBACK_PROFILE_ID" ]; then
  FALLBACK_JSON="{\"profile_id\": \"$FALLBACK_PROFILE_ID\", \"engine\": \"$FALLBACK_ENGINE\", \"language\": \"en\", \"model_size\": $FB_SIZE_JSON}"
else
  FALLBACK_JSON=null
fi

cat > groups/<folder>/voice-reply.json <<EOF
{
  "voicebox_url": "$VOICEBOX_URL",
  "profile_id": "$PROFILE_ID",
  "engine": "$ENGINE",
  "language": "$LANGUAGE",
  "model_size": $MODEL_SIZE_JSON,
  "cacert": $CACERT_JSON,
  "mode": "<always|on-request>",
  "fallback": $FALLBACK_JSON
}
EOF
python3 -m json.tool groups/<folder>/voice-reply.json
```

The `json.tool` line is the check that matters — the agent reads this file every time it
speaks, and a trailing comma or an unquoted value silently disables voice for that group.
Confirm the `fallback` key came out as either `null` or an object with all four keys; a
half-written fallback is worse than none, because the agent will try it and fail at the
moment it already had nothing to say.

Groups can differ. A Hebrew DM and an English work group are two files with different
`profile_id`, `engine`, and `language` — and the English group has no use for a fallback at
all.

If the group's `container.json` lists skills explicitly rather than `"all"`, add
`voice-reply` to that array:

```bash
python3 -c "
import json,sys
p='groups/<folder>/container.json'
c=json.load(open(p))
if isinstance(c.get('skills'),list) and 'voice-reply' not in c['skills']:
    c['skills'].append('voice-reply'); json.dump(c,open(p,'w'),indent=2)
    print('added')
else: print('no change needed')
"
```

### Groups set to `always`

A skill loads when the agent judges it relevant, which is exactly right for `on-request`
and not enough for `always`. Those groups need a standing instruction. Append one line to
`groups/<folder>/instructions.prepend.md`, checking first so a re-run doesn't double it:

```bash
grep -q 'voice-reply' groups/<folder>/instructions.prepend.md 2>/dev/null || cat >> groups/<folder>/instructions.prepend.md <<'EOF'

Answer this chat by voice. For every reply, follow the `voice-reply` skill and send the
spoken version instead of a text message. Reply in text only when the content cannot be
spoken — code, tables, links — or when voice generation fails.
EOF
```

Leave `instructions.prepend.md` untouched for `on-request` groups. Their settings file is
enough; the skill description is what pulls it in when a user asks.

## Step 9: Verify with a real message

Restart so the groups pick up their new files:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)      # Linux
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

Ask the user to message a speaking group — "send me a voice note saying hello" for an
`on-request` group, anything at all for an `always` one. A voice note should arrive and
play, in the chosen voice and language.

If text comes back instead, the agent will usually say why. `logs/nanoclaw.error.log` and
the [Troubleshooting](#troubleshooting) table below cover the rest.

---

## Troubleshooting

**The agent says voice isn't configured for this chat.** `voice-reply.json` is missing from
that group's folder, or it isn't valid JSON. Re-run Step 8 and the `json.tool` check.

**Nothing happens and the agent never mentions voice.** The skill isn't in its container.
Check `container/skills/voice-reply/SKILL.md` exists, then check the group's `container.json`
— an explicit `skills` array must list `voice-reply`.

**Every attempt returns 502.** `--noproxy '*'` was dropped from the curl. The container's
egress proxy refuses the VoiceBox host; the skill reaches it directly.

**`curl: (60) SSL certificate problem` in the container only.** The container CA bundle
doesn't cover the VoiceBox certificate. Step 6's certificate section.

**`only supports engine 'X', not 'Y'`.** `engine` in `voice-reply.json` contradicts the
profile. Set it to `X`, or pick a profile matching the engine you want.

**`Model ... is not downloaded yet`.** The engine's model is absent on the server. Download
it as in Step 2. Synthesis never triggers a download.

**The voice note is silent, garbled, or reads out asterisks.** A language the engine can't
speak (`kokoro` given Hebrew), or markdown left in the text. Check `language` against the
engine, and that the agent is stripping formatting.

**Everything comes back in English now.** The fallback is being used as the normal voice.
The agent is told to speak `language` and to reach for `fallback` only when it can't — if it
does otherwise, the standing instruction in `instructions.prepend.md` is the place to say so
plainly for that group.

**"Answer in English" still gets a text reply.** No `fallback` in that group's
`voice-reply.json`, or it's missing a key. Step 5, then Step 8.

**The fallback fails with `Model ... is not downloaded yet`.** The fallback engine's model
was never downloaded — easy to miss, because nothing exercises it until the primary is
already stuck. Download it as in Step 2 and re-run the Step 5 probe.

**Voice notes arrive but the accompanying text doesn't.** Expected on WhatsApp — captions
are dropped on audio messages. Text has to be a separate message.

**Replies got slow after enabling.** Every reply now waits on synthesis. On a CPU-only
server (`gpu_available: false` in `/health`) a long answer takes seconds. Move that group to
`on-request`, or choose a lighter engine — `kokoro` and `phonikud` are the cheapest.

**A group speaks when it shouldn't (or won't when it should).** `mode` in its
`voice-reply.json`, plus whether the standing instruction is in its
`instructions.prepend.md`. `always` needs both; `on-request` needs the file only.
