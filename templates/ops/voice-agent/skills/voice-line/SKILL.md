---
name: voice-line
description: Operate a phone line end to end — set up a line, import or assign a number, create or edit a voice persona, place an outbound call, hang up a live call, run a calling campaign, triage inbound and outbound call results, or answer which voice providers are supported. Use whenever the user talks about calling someone, a number, a caller, a voicemail, what was said on a call, or connecting a telephony provider.
---

# Voice line

You operate a phone line through a speech provider's voice agents. Five CLI
tools do the work; this file routes you to the one reference that covers the
situation in front of you. Read the reference before acting — the detail is
there, not here.

All tools live at `/workspace/agent/plugins/voice-agent/tools/` and run with
`bun`. Every one takes `--json` and `--help`, and `--help` never touches the
network.

## Tool cheat-sheet

| Tool | Commands |
|---|---|
| `lines.ts` | `list` (also detects each line's carrier), `assign <lineId> <personaId> \| --none`, `carrier` (record the carrier identifiers hang-up needs — never a credential) |
| `personas.ts` | `list`, `show <id>`, `create`, `update <id>` |
| `call.ts` | `dial --to --line --persona [--var k=v] --yes`, `hangup [<id>] [--dry-run]` |
| `campaign.ts` | `submit`, `status <id>`, `cancel <id>` |
| `calls.ts` | `list [--live] [--direction] [--since] [--limit] [--persona]`, `show <id> [--transcript]` |

Run `bun <tool> --help` for exact flags rather than guessing them.

## Hard rails

- **Confirm every dial.** Say back who is being called, on which number, which
  persona speaks, and every variable value — then wait for an explicit yes.
  `call.ts dial` enforces this: without `--yes` it prints the confirmation and
  refuses. One yes covers one call; a corrected number or a retry needs a fresh
  yes.
- **Never re-dial on silence.** The tool returns when the provider *accepts* the
  call. Quiet means it is still running; the outcome arrives later.
- **A scheduled task never dials.** No human is in the turn, so a task run
  reports and proposes. Never `ask_user_question` in a task run — nobody is
  there to answer it.
- **Never ask for a key in chat, and never walk a vault entry.** Credentials
  were put in the OneCLI vault host-side, from `SETUP.md`, before this group was
  wired; nothing in this container ever holds one. On a 401 you report and point
  at the fix — you do not conduct the setup.
- **Never write inside the plugin directory** — it is mounted read-only. All
  state lives under `/workspace/agent/voice-line/`.
- **Never write trunk config or SIP digest credentials.** The tools refuse; the
  user sets them in the ElevenLabs dashboard.
- **Outbound calling is regulated.** The list and the consent behind it are the
  operator's responsibility.

## Plays → references

| The situation | Read |
|---|---|
| A tool returned 401/403; something is not connected; someone asks for a key | `references/connect-provider.md` |
| First line; surveying numbers; writing a persona and wiring it to a number; adding `end_call` | `references/set-up-the-line.md` |
| "Hang up", "end that call", or deciding *before* a call whether hang-up is possible | `references/ending-a-call.md` |
| "Call this person", one outbound call, dynamic variables, the confirm protocol | `references/placing-calls.md` |
| Calling a list, batch, scheduling, cancelling a batch | `references/campaigns.md` |
| A sweep delivered calls; triaging inbound; following up outbound; transcripts | `references/working-results.md` |
| "Can you use OpenAI / Gemini?"; what this install can do; adding a provider | `references/providers.md` |

If two rows seem to fit, take the one that names the *action* the user asked
for, not the one that names the tool.
