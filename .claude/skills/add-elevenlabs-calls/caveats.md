# Caveats — read before relying on this

## 1. An in-progress call cannot be ended from here

Once `start_call` returns, the call is running and nothing in this skill can stop it.

ElevenLabs exposes no REST endpoint for terminating a live conversation. The only remote control
is the enterprise-tier monitor WebSocket, which needs a persistent bidirectional connection —
something that cannot traverse the OneCLI credential proxy, so an agent container could not use
it even on a plan that offers it.

What actually ends a call is the ElevenLabs agent's own `end_call` system tool, firing on the
conditions its prompt describes, or the person hanging up. So:

- **A persona with no `end_call` tool and no clear stopping condition runs until the callee hangs
  up.** That is a property of the persona, configured in ElevenLabs, and it is worth checking
  before enabling one for a group.
- **A wrong call cannot be recalled.** That is why the container skill's rule is confirm before
  *every* dial rather than once per conversation, and why there is no dry-run mode: there is
  nothing to undo with.

## 2. There is no approval gate on placing a call, and this design cannot reach one

NanoClaw's guard/approval seam (`src/guard/`) covers exactly two entry points: `ncl` dispatch and
delivery actions written into a session's `outbound.db`. An MCP server making a direct outbound
HTTP call touches neither, so `defineGuardedAction` and `requestApproval` cannot see it. This
isn't an oversight — it is outside what that seam observes.

Two things constrain calling instead.

**The tool surface, which is real.** A group without `start_call` in its `capabilities` has no
dialing tool at all, and a persona absent from its `config.json` cannot be dialed. Neither is a
refusal the agent could be talked around; there is no tool call that reaches them. That is the
lever to use — if a group placing a phone call on the strength of a chat message is not
something you want, don't give that group `start_call`.

**Prose, which is a strong default and not a guarantee.** The tool descriptions and the
container skill tell the agent to state who, which number, which persona and which variables,
and to wait for a yes, every single time. That holds in normal operation and it is not a gate.

Two consequences worth stating to the user plainly:

- **Everyone who can message an enabled group can cause a phone call.** In a group chat that is
  every participant, including anyone added later. Scope enabled groups accordingly.
- **A scheduled task can dial.** A task run has no human in the turn to confirm to, so a task
  prompt that instructs a call gets one, unconfirmed. Treat a group with both `start_call` and
  scheduled tasks as capable of calling people unattended.

A real gate would mean routing the dial through a delivery action — the agent writes a row to
`outbound.db` and the host places the call only after an approval — which is a substantially
larger change, deliberately out of scope here.

### And group selection is not a network boundary either

Every OneCLI agent on this install is `secretMode: "all"` by default. In that mode the gateway
injects **every** vault secret whose host pattern matches — so once the ElevenLabs secret exists,
its key is injected into any agent group's proxied requests to `api.elevenlabs.io`, including
groups that were never enabled here. Those groups have no calling tools, no persona list and no
number to dial from, but they have a shell and ElevenLabs is a plain HTTPS API on a public host.

Making that a real boundary means putting other agents into `selective` mode
(`onecli agents set-secret-mode --id <agent-id> --mode selective`) and then explicitly assigning
every secret they currently receive for free — which breaks their existing credentials if done
carelessly. That is a deliberate, install-wide decision about the whole vault, not a side effect
this skill should cause, which is why it doesn't.

The upside of the same design: nothing carries the key on disk. There is no per-group token
file, no `chmod 600`, and `config.json` holds only ids, numbers and variable names. Revocation is
one vault delete plus one dashboard revoke, not a hunt through group folders.

## 3. The dynamic-variable snapshot is captured at install time

Each group's `config.json` records the variables each persona expected when
`${CLAUDE_SKILL_DIR}/discover.md` last ran, and the server renders that into the `start_call`
description at startup. Editing a persona's prompt in ElevenLabs changes what it needs without
changing any of that.

The failure is quiet in one direction and loud in the other:

- **A newly added variable** is not in the snapshot, so nothing asks the agent to supply it. The
  call goes out and the persona's opening line has a gap in it, which you find out from the
  transcript.
- **A removed variable** is still required by the snapshot, so `start_call` refuses until the
  agent supplies something the persona no longer uses.

`list_agents` re-reads the variables live and is the in-conversation answer. The durable fix is
re-running `discover.md` and then `enable.md` step 2 for every group using that persona — which
is why the config keeps the variables rather than fetching them at every dial: a call that
depends on an extra HTTP round-trip to know its own arguments is a call that fails when
ElevenLabs is slow.

## 4. The container skill is visible to every agent group

`container/skills/` is a single global read-only mount and the default `skills: 'all'` selection
re-reads it at every spawn (`src/container-runner.ts`); no `ncl` verb writes the per-group
`skills` column. So `elevenlabs-calls/SKILL.md` is in every group's context, enabled or not.

That is harmless, and it is why the skill is written the way it is: its first instruction is
that no `mcp__elevenlabs__*` tools means it isn't set up for this group, and a group with no
registration genuinely has none. It is also why the skill carries **no persona list** — anything
written there would show every group every other group's personas and phone numbers. The
per-group list lives in the tool descriptions, which are built per group by construction.

The cost is a little context in groups that never call anyone.

## 5. Each gated poll fire spawns the group's container

While a call is live, the `el-call-…` task fires every two minutes. Each fire runs `poll.ts` as a
gate script: it costs **zero LLM tokens** while the call is still going — the agent is never
woken — but it does spawn the group's container for a few seconds if the group is idle.

A typical call is two or three of those. A call that runs long, or a series the agent forgets to
cancel, keeps going until `deadline_minutes` (30 by default), so the worst case for a forgotten
series is fifteen spawns rather than an unbounded loop.

Two knobs, both in the group's `config.json`: `poll.recurrence` for the cadence and
`poll.deadline_minutes` for the backstop. Slowing the cadence delays every report by the same
amount, so it is a trade against how quickly the user hears what was said.

## 6. `elevenlabs-mcp/proxy.ts` duplicates `ha-mcp/proxy.ts`

Both files recover `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from `/proc/1/environ`, for the same
reason: `StdioClientTransport` spawns an MCP server with an environment allowlist of exactly
`HOME, LOGNAME, PATH, SHELL, TERM, USER`, so a server that just calls `fetch` bypasses the
credential gateway and gets a `401` with no hint a proxy was ever involved.

The duplication is deliberate. A skill has to install standalone: `/add-elevenlabs-calls` cannot
depend on `/add-homeassistant` being present, and a shared module would have to live somewhere
neither skill owns — which means a tracked file, which means this skill stops being additive.
Two copies of forty lines is the cheaper end of that trade.

The practical consequence: a fix to the proxy recovery has to be made in both places, and
`REMOVE.md` deleting this skill's copy leaves the Home Assistant one alone.
