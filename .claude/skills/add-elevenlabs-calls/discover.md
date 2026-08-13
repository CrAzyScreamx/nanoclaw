# Discover the account's agents, numbers and variables

Needs `XI_API_KEY` in the shell from `${CLAUDE_SKILL_DIR}/connect.md`, and the server installed
by `${CLAUDE_SKILL_DIR}/install.md` — the discovery script imports the same variable extractor
the MCP server uses, so what you see here is exactly what the tool descriptions will say.

Read-only throughout: this phase lists things and changes nothing, in ElevenLabs or on disk.

## 1. Run the discovery script

```bash
bun container/agent-runner/src/elevenlabs-mcp/discover.ts
```

It reads `XI_API_KEY` from the environment and calls `api.elevenlabs.io` directly — the host
does not go through the credential proxy, which is why the raw key is still in this shell.

For each voice agent it prints the name, the `agent_id`, the dynamic variables the agent's
prompt and first message reference, and where each variable is used. For each imported phone
number it prints the `phone_number_id`, the number in E.164, and the provider (`twilio` or
`sip_trunk`). It also prints a JSON entry per agent, in the shape
`groups/<folder>/elevenlabs/config.json` expects.

If it exits with an auth error, the key expired or was rotated between phases — go back to
`connect.md` step 1.

## 2. Show the user the table

Render what came back as a single table they can choose from. Names and numbers, not ids —
`agent_01xyz` means nothing to anyone while "Reception" does:

| Persona | Dials from | Needs |
|---|---|---|
| Reception | +972 52 123 4567 (twilio) | `customer_name`, `order_id` |
| Appointment Reminder | +972 52 123 4567 (twilio) | `patient_name`, `when` |

Keep the raw `agent_id`, `phone_number_id`, `phone_number` and `provider` values in the
conversation too — `enable.md` writes them verbatim into each group's config, and re-fetching
them later means running this phase again.

Three things to point out while showing it, because each changes what the user should pick:

- **An agent with no phone number cannot dial.** ElevenLabs binds the caller ID at call time, so
  a persona is only usable once a number is chosen for it. If the account has exactly one
  number, every agent uses it and there is nothing to decide.
- **The variables are what the agent will be asked to supply on every call.** A persona
  expecting `order_id` is unusable to a group that never has order ids. Say so now rather than
  letting the user enable a persona that will fail its own validation.
- **A variable that reads like a credential is a problem in the persona, not here.** The
  extractor drops ElevenLabs' own `system__*` variables and any `secret__*`, so anything left in
  the list is something NanoClaw's agent will pass in plain text on every call. If one looks
  sensitive, the fix belongs in the ElevenLabs prompt.

## 3. Ask which groups to enable

Ask which agent groups should be able to place calls, and be concrete about the blast radius:
everyone who can message an enabled group can ask it to phone someone, using any persona that
group is given (`${CLAUDE_SKILL_DIR}/caveats.md` #2). A household or personal group is a
different proposition from a channel with guests in it.

Resolve the ids for what they name:

```bash
ncl groups list
```

## Carry forward

The per-agent values (`agent_id`, `name`, `phone_number_id`, `phone_number`, `provider`, and the
dynamic-variable list), plus the group ids the user picked, go into
`${CLAUDE_SKILL_DIR}/enable.md`. `IMAGE`, `NET` and `LIVE` carry on unchanged.
