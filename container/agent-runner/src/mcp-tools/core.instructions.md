## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Sending a location (`send_location`)

Use `mcp__nanoclaw__send_location({ to, latitude, longitude, name?, address? })` to drop a pin on the map — decimal degrees, so `32.0853` / `34.7818`, not degrees-minutes-seconds. `name` and `address` are the two lines the chat client shows under the map thumbnail. Channels that render pins natively (WhatsApp) show a tappable map; the rest fall back to a maps link automatically, so you don't need to check which channel you're on. Send coordinates you actually know — never guess a lat/long to satisfy the call.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
