# Setup — host-side, before the first message

Follow this **on the host**, in whatever coding agent drives this install, straight after

```bash
ncl groups create --template home/grocery-list --name "Grocery List"
```

and **before** wiring the group to a channel. Nothing here can be asked in chat: an unwired
group has nobody to ask, the language and week start shape every line the group will ever see,
and the printing half needs `sudo`, which no agent should attempt. Every step is idempotent and
nothing here deletes anything.

**The rule that outranks the steps:** anything needing `sudo` is handed to the operator, not
run by you — print the exact command, ask them to run it in their own terminal, and wait. What
you run yourself is read-only checks, `ncl` calls, and writes inside this install's `groups/`.

## 1. Resolve the group

`ncl groups list` gives `<group-id>` (the `ag-…` id every `ncl … --id` wants) and `<folder>` (the
directory under `groups/`, derived from the agent name at stamp time).

| Host path | Inside the container | Holds |
|---|---|---|
| `groups/<folder>/` | `/workspace/agent/` | the whole workspace |
| `groups/<folder>/market/` | `/workspace/agent/market/` | `config.json`, `grocery.db` |
| `groups/<folder>/plugins/grocery-list/` | `/workspace/agent/plugins/grocery-list/` | this plugin, read-only |

## 2. Language, week start, and the weekly tasks

Ask two questions — which language the list speaks (`he-IL` or `en-US`), and which day and hour
the shopping week rolls over (default Wednesday 10:00) — and write both to
`groups/<folder>/market/config.json`. The database seeds its aisle names from the chosen pack on
the container's first run, so this comes before anything is added. → **`setup/locale.md`** — the
exact file, both fields, and what changing either later does to a list that already exists.

The three weekly tasks were stamped at the Wednesday default and arrive **paused**. Retime
them to match, then ask which should run:

```bash
ncl tasks list --group <group-id>                             # ids are <slug>-<hex>, generated at stamp time
ncl tasks update --id <series-id> --recurrence "0 20 * * 2"   # eve reminder: the evening before
ncl tasks update --id <series-id> --recurrence "0 10 * * 3"   # rotation: at the boundary
ncl tasks update --id <series-id> --recurrence "0 22 * * 3"   # fallback: that evening
ncl tasks resume --id <series-id>                             # only the ones they want
```

Cron fires in the **group's** timezone, so settle step 4 first if it is not the install default.
Resuming none is a valid answer: the week still rolls over lazily on the next command, it is
simply never announced.

## 3. Printing — optional

Ask whether the group wants the list on paper. If not, skip this step entirely: the PDF works
either way, and `grocery.ts print` says plainly which piece is missing. If yes, it is host CUPS
plus one package in the group's image, in that order. → **`setup/printing.md`** — the walkthrough
and the end-to-end verification, using `setup/host-cups.md`, `setup/printer-setup.md` and
`setup/caveats.md`; read the last before promising anything about approvals or job status.

## 4. Runtime settings — offer, do not force

Templates carry no provider, model, effort or timezone; both commands below need a restart.

```bash
ncl groups config update --id <group-id> --model <model>
ncl groups config update --id <group-id> --timezone "Asia/Jerusalem"   # if not the install default
ncl groups restart --id <group-id>
```

- **Timezone matters more than usual** — the week boundary and all three task schedules are
  read in the group's.
- **Model:** the work is shaped for a small one — the CLI renders every line and the agent
  picks a verb and forwards output. Reading a receipt photo is the exception; see step 5.
- **On a small model, turn tool search off** — `{"env": {"ENABLE_TOOL_SEARCH": "false"}}` in
  `groups/<folder>/.claude/settings.json`, merged if the file exists. Deferred tool loading
  costs a small model turns it spends looping instead of answering.

## 5. The receipt reader — optional, provider-shaped

A receipt photo is read once, on its own, before anything touches the list. That brief ships in
the plugin, provider-neutral; what differs is whether your provider can run it as a separate
agent. If it can, install it there on a vision-capable model — this is the one job the small
model above is bad at, and it fails by inventing items rather than erroring. If not, skip it:
the assistant follows the same brief itself. → **`setup/receipt-reader.md`**.

## 6. Prove the classifier is reachable, then hand off

Aisles are chosen by a model call that only works from **inside** a container:

```bash
ncl groups restart --id <group-id> \
  --message "run: bun /workspace/agent/plugins/grocery-list/tools/grocery.ts categories --probe"
```

A shape reporting HTTP 200 with a matched category means classification is live. All-failing is
safe and not a blocker — products land in the catch-all aisle and a later run sweeps them. Then
wire the group to a channel (`/manage-channels`, or `ncl wirings create`) and stop. The
**welcome** skill runs on the first incoming message: it greets the group in the configured
language, puts their first few items on the list so everyone sees the confirmation shape once,
and asks the one question this runbook leaves open — may it remember what a reading got wrong.
