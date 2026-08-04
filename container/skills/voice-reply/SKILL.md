---
name: voice-reply
description: Speak a reply out loud as a voice note instead of sending it as text, using the VoiceBox TTS server. Use when asked to reply with voice, answer aloud, send a voice note or audio message, "say it", "talk to me", or when your standing instructions tell you to answer this chat in voice.
---

# Voice reply

You send a spoken version of your reply as an audio attachment. Three steps: synthesize
the words to WAV, transcode that WAV to Ogg/Opus, hand the Ogg to `send_file`.

## First: read your settings

```bash
cat /workspace/agent/voice-reply.json
```

**Run that `cat` every single time you are about to speak — including when you already spoke
earlier in this conversation.** Never reuse a `profile_id`, `engine`, or `fallback` you
remember from an earlier turn. Your conversation outlives the container: the operator edits
this file between turns, and values you memorized hours ago are silently out of date. A
stale read is the single most common cause of a voice reply coming out in the wrong voice,
and nothing downstream will catch it — see the warning under *Generate and convert*.

**If that file does not exist, voice replies are not configured for this group.** Reply in
text. If you were asked for voice, say plainly that this chat isn't set up for it — do not
improvise another audio route.

The file gives you every value the commands below need:

| Key | Used as |
|---|---|
| `voicebox_url` | Base URL of the TTS server |
| `profile_id` | The voice — `profile_id` in the request body |
| `engine` | Synthesis engine — must match the profile, or the call is a 400 |
| `language` | Two-letter code of the language you speak in |
| `model_size` | Send it only when non-null (`qwen`, `qwen_custom_voice`, `tada`) |
| `cacert` | Path for `--cacert`; when null, drop that flag entirely |
| `mode` | `always` = voice every reply; `on-request` = only when asked |
| `fallback` | A second, English-only voice — same four keys. `null` or absent = none |

## Which voice, and which language

Speak in `language` with `profile_id` / `engine`. That is the normal path and covers almost
every reply.

Switch to the `fallback` voice — `fallback.profile_id`, `fallback.engine`,
`fallback.model_size`, and `language: "en"` — in exactly two situations:

1. **The user asked for English.** "Say it in English", "answer me in English", or they are
   clearly writing to you in English and expect to be answered that way.
2. **The reply cannot be spoken in `language`.** The content belongs in another language —
   quoting someone, answering about text in a third language — and forcing it through the
   primary voice would come out mispronounced or silent.

When you use the fallback, **write the reply in English**. It is an English voice: handing
it Hebrew or Russian produces noise, not speech. Say the same thing you would have said,
in English.

**A `fallback` that is `null`, or missing from the file entirely, means there is no second
voice** — the common case, and not a misconfiguration. In either situation above, reply in
text instead and say why in one short line. Never send the other language through the
primary voice hoping it works, and never invent a profile id.

Everything else stays on the primary voice. The fallback is a fallback — not the voice you
reach for because English feels easier.

## Write what you would have said

The text you synthesize is your actual answer, spoken. Not a description of an answer, and
never "here is your audio" — the voice note *is* the reply.

Write it to be heard rather than read:

- **No markdown.** Asterisks, backticks, and bullet characters get pronounced.
- **Short.** A voice note is listened to end to end and cannot be skimmed. Two or three
  sentences. When the answer needs a table, a list, or code, send that as text and use
  voice only for the summary.
- **In the `language` from your settings** — or English when you are using the fallback
  voice, per the section above.
- **Expand what doesn't read aloud** — URLs, long numbers, `/paths/like/this`.

## Generate and convert

One block, because each run needs its own filenames. The quoted heredoc (`<<'JSON'`) is
what makes arbitrary text safe: nothing inside it is interpreted by the shell, so quotes
and apostrophes pass straight through. It still has to be **valid JSON** — escape `"` as
`\"` and newlines as `\n`.

Substitute your settings for `<...>`:

```bash
V=<voicebox_url>
CA="--cacert <cacert>"     # drop this line and the $CA below when cacert is null
ID=$(date +%s)-$$
cat > /tmp/say-$ID.json <<'JSON'
{"profile_id":"<profile_id>","text":"<what you are saying>","language":"<language>","engine":"<engine>"}
JSON
curl -sS --noproxy '*' $CA --fail-with-body --max-time 300 -X POST "$V/generate/stream" \
  -H 'Content-Type: application/json' --data-binary @/tmp/say-$ID.json -o /tmp/say-$ID.wav \
&& curl -sS --noproxy '*' $CA --fail-with-body --max-time 120 -X POST "$V/convert" \
  -F file=@/tmp/say-$ID.wav -F format=ogg -o /tmp/say-$ID.ogg \
&& rm -f /tmp/say-$ID.wav /tmp/say-$ID.json \
&& echo "READY /tmp/say-$ID.ogg"
```

Add `,"model_size":"<model_size>"` to the JSON when your settings carry one.

**The server does not check that `engine` can speak `language`.** Sending English text to a
Hebrew-only engine, or the reverse, returns HTTP 200 and a perfectly valid WAV full of
noise — you will see `READY` and send a broken voice note believing it worked. There is no
error to catch here. The only thing standing between you and that outcome is having read
the settings this turn and picked the right voice for the language you are speaking.

For a fallback reply, the only difference is which values you substitute: `profile_id`,
`engine`, and `model_size` come from the `fallback` object and `language` is `"en"`.
`voicebox_url` and `cacert` are shared — they are the same server.

`--noproxy '*'` is required. The container's egress proxy answers **502** for the VoiceBox
host; the server is reached directly.

Send the file only after you see the `READY` line with a path. Anything else means the
audio does not exist — read the error and see Failures below.

## Send it

```
send_file(to: "<the destination you would reply to>", path: "/tmp/say-<ID>.ogg")
```

Use the path from the `READY` line verbatim. It is unique per run — never reuse a path
from an earlier turn, which would send stale audio.

`to` is the same destination name you would pass to `send_message`.

**WhatsApp drops the caption on audio.** `send_file`'s `text` argument is silently
discarded for `.ogg`, so anything you want in writing goes in a separate `send_message`.
In `always` mode, send the voice note alone unless there is content that genuinely cannot
be spoken.

## Failures

Fall back to a plain text reply and tell the user voice didn't work. One retry at most —
never leave a message unanswered because the audio failed.

That one retry is best spent on the `fallback` voice when you have one and the primary is
the thing that broke: re-run the block with the fallback values and the reply written in
English, and say in a line that you switched voices. If the fallback fails too, or there is
no fallback, reply in text. A voice failure is never a reason to go quiet.

| What you see | Meaning |
|---|---|
| `only supports engine 'X', not 'Y'` | `engine` and `profile_id` disagree. Use engine `X` for this run and mention the mismatch — the settings file needs fixing. |
| `Model ... is not downloaded yet` | The engine's model is missing on the server. Try the fallback voice; otherwise text reply and the operator downloads it. |
| `curl: (60) SSL certificate problem` | `cacert` is missing or wrong for this server. |
| HTTP 502, or a proxy error page | `--noproxy '*'` was left off. |
| `Unsupported format` from `/convert` | `format=ogg` was mistyped. |
| Timeout on `/generate/stream` | Long text on a CPU-only server. Shorten it and retry once. |
