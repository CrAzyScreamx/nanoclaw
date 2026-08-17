# Grocery List Template

A NanoClaw template for the **household shopping list** that lives in a group
chat. People say what they need in the language they actually speak; the agent
keeps one list per shopping week, confirms every change in a line that can be
read at a glance, marks things off as they are bought, rolls the week over on a
schedule, and turns the list into a printable sheet sorted the way the shop is
laid out.

It is built around one idea: **the agent never assembles the output.** A small
model asked to format a list will drop the "5%" off the cottage cheese, number
items by database id, or send yesterday's PDF back without rendering anything —
all three happened. So every line a person sees is rendered by the CLI in
`tools/`, and the agent's job is to run one verb and forward what came back.

Aisles are decided by a model, once per product, and then stored. There is no
keyword list, which is what makes this template work in any language rather than
only the one the keywords were written for. Adding a language is adding one JSON
file to `tools/locales/`.

## What it does

| | |
|---|---|
| Add | `milk 2`, `cottage cheese 250 g 5%` — merges into the row already on this week's list, adds the counts, and confirms in one line |
| Same product, new phrasing | asks once ("is *zero* the same as *coca cola zero*?"), remembers the answer forever as an alias |
| Show | one numbered chat message; the numbers are **positions**, never row ids |
| Mark off | by the number the group quoted back, resolved against the list they were looking at |
| The week | opens on a configured day and hour, rolls over lazily, carries nothing forward unless someone asks |
| Print | a PDF sheet grouped by aisle, and — if a printer was set up — a real paper job through CUPS |
| Receipts | a photo of a receipt is read on its own, confirmed with the group, then used to mark items off |

## This uses a paid API — read this first

Product classification calls the **Anthropic Messages API** on **your own key**.

- Pricing: <https://www.anthropic.com/pricing> · console:
  <https://console.anthropic.com>
- The relevant plan is the API's **pay-as-you-go Build plan** (usage tiers 1–4
  govern rate limits, not access). There is no free tier for the Messages API,
  and no price is quoted here because prices change.
- You bring your own key. This template ships **no credential of any kind**, and
  the key is never in the container: the tools send **no auth header** and the
  OneCLI gateway injects it at the proxy boundary.
- **The usage is small and bounded.** One call the first time a product is
  named, one more only when a typed name might be a product already on file.
  The default model is `claude-haiku-4-5-20251001`; a household list settles into a few
  calls a week once the regulars are on file.
- **The list works completely without it.** Every classifier failure — no key,
  no network, a timeout, a nonsense answer — lands the product in the catch-all
  aisle and the add succeeds. A later run sweeps it back into the right aisle.
  Set `MARKETY_CLASSIFY_DISABLED=1` to turn the classifier off entirely and
  everything except aisle sorting behaves exactly as before.

## Credentials: via the OneCLI vault, never in the template

| Service | API host to match | Auth style | Scopes the key needs | Where to get the key |
|---|---|---|---|---|
| Anthropic Messages API | `api.anthropic.com` | header `x-api-key`, value format `{value}` — the tools send a **sentinel**, the gateway overwrites it | **None.** The Messages API has no scope system; a standard API key is the whole requirement | Anthropic Console → API keys (<https://console.anthropic.com/settings/keys>) |

The tools try `x-api-key`, then `authorization: Bearer`, then no header at all,
and remember which shape the gateway accepted. Both values sent are literal
sentinels (`onecli-managed`, `placeholder`) that the gateway replaces — no
credential ever exists in the container process.

`bun tools/grocery.ts categories --probe` is the one-command answer to "is the
classifier actually wired?", and `SETUP.md` uses it. It cannot be answered from
the host: the gateway only injects credentials for traffic that originates
inside an agent container.

## Setup: `SETUP.md`, on the host, after stamping and before wiring

**[`SETUP.md`](SETUP.md) is a required step, not an appendix.** It decides the
language, the week start, and whether paper printing exists — and it has to run
before the group is wired to a channel, because an unwired group has nobody to
ask and the printing half needs `sudo` on the host, which no agent should be
attempting.

| Step | Covers | File |
|---|---|---|
| Language | `he-IL` or `en-US`, written to the group's `market/config.json` | `setup/locale.md` |
| Week start | which day and hour the week turns over; retimes and resumes the three paused tasks | `SETUP.md` |
| Printing | host CUPS on the container gateway, driverless printer discovery, `cups-client` in the image | `setup/printing.md`, `setup/host-cups.md`, `setup/printer-setup.md`, `setup/caveats.md` |
| Runtime | model choice and the `ENABLE_TOOL_SEARCH=false` setting that matters on small models | `SETUP.md` |
| Receipt reader | whether your provider can run the receipt brief as its own agent, and how to install it if so | `setup/receipt-reader.md` |

`SETUP.md` and `setup/` ship inside the plugin, so the agent can read them too
and quote the operator's own runbook rather than inventing a procedure.

## Stamp an agent from this template

```bash
mkdir -p <nanoclaw>/templates/home
cp -R home/grocery-list <nanoclaw>/templates/home/
ncl groups create --template home/grocery-list --name "Grocery List"
```

Then follow [`SETUP.md`](SETUP.md), and only then wire the group to a channel.
The **welcome** skill runs on the first message: it greets the group in the
configured language, walks the first few items so everyone sees the
confirmation shape once, and offers the receipt-corrections memory.

## Layout

```
grocery-list/
├── plugin.json                       # Agent Plugins manifest (marks the folder as a plugin)
├── README.md                         # this file
├── SETUP.md                          # host-side runbook: after stamping, before wiring
├── setup/                            # the long half of SETUP.md, one file per decision
│   ├── locale.md  printing.md  host-cups.md  printer-setup.md  caveats.md
│   └── receipt-reader.md             # installing the receipt reader for your provider
├── ai.nanoco.nanoclaw/
│   ├── context/
│   │   ├── instructions.md           # the standing brief
│   │   └── additional_context/
│   │       └── workspace-layout.md   # the state dir and which verb writes what
│   └── tasks/                        # three weekly series, created PAUSED
│       ├── week-eve-reminder.md      #   the evening before the boundary
│       ├── week-rotation.md          #   the rollover announcement
│       └── week-rotation-fallback.md #   the same evening, if nobody answered
├── skills/
│   ├── grocery-list/                 # the router: verbs, hard rails, references/
│   ├── hebrew-style/                 # Hebrew writing rules (see "shadowing" below)
│   ├── printing/                     # discovery, queues, and the error table
│   └── welcome/                      # first contact only
└── tools/                            # TypeScript run with `bun`; no build step
    ├── grocery.ts                    # the entry point: one ToolSpec, one runTool
    ├── package.json  tsconfig.json   # dev-only; nothing is built or installed at runtime
    ├── locales/he-IL.json  en-US.json
    ├── lib/                          # db · types · errors · cli · locale · time · weeks ·
    │                                 # bootstrap · categories · products · product-match ·
    │                                 # classify · purchases · render · sheets · printable
    ├── commands/                     # add · views · edit · report · rotate · print ·
    │                                 # products · categories · config
    ├── assets/                       # list-template.html + _template-src/
    └── tests/                        # locale · add-confirm · categories · products · message
```

There is **no `mcp.json`** and no MCP server, deliberately. A stdio MCP server
does not inherit the container environment, so `HTTPS_PROXY` and
`NODE_EXTRA_CA_CERTS` would be dropped and every classifier call would 401 with
no hint why. The tools are ordinary CLI scripts the agent runs through Bash, so
the proxy and the CA just work — and because there is no `mcp.json`, there is no
`"placeholder"` env var anywhere in this template either.

## Two things a reader needs to know

**The PDF path needs chromium.** `tools/lib/printable.ts` spawns
`AGENT_BROWSER_EXECUTABLE_PATH || /usr/bin/chromium` headless to render the
sheet. Chromium ships in the NanoClaw container image and that variable is
already set there, so **no package needs to be added** — but if you run these
tools somewhere else, that is the dependency.

**`skills/hebrew-style/`, `skills/printing/` and `skills/welcome/` shadow the
container skills of the same name, by design.** A template skill lands in the
group's skill overlay as a real directory, and the container skill's symlink is
then skipped. All three copies here are self-contained: `printing` carries its
own error table (including the cupsd 400 that a missing `ServerAlias
host.docker.internal` produces, which surfaces as a misleading
`add '/version=1.1'` message), `hebrew-style` carries the whole writing guide,
and `welcome` deliberately replaces the container's generic channel-onboarding
walkthrough with a grocery-list first run — by the time it fires, language, week
start, tasks and printing have all been decided in `SETUP.md`, so the generic
version would ask for them again. The template's copies win and nothing depends
on which container skills the group happens to have selected.

## State: everything writable is in one directory

The plugin is mounted **read-only** at
`/workspace/agent/plugins/grocery-list/`. Everything this template remembers
lives under `/workspace/agent/market/`:

| Path | What |
|---|---|
| `market/grocery.db` | the list, its history, products and aisles |
| `market/config.json` | language, week start, the receipt-corrections switch |
| `/tmp/grocery-sheets/run-*/` | rendered PDFs, reaped after 10 minutes |

Sheets go to `/tmp` on purpose. Under the group mount a sheet survives the
container with a predictable name, and the agent was observed sending that
morning's file back without rendering anything. Under `/tmp` the stale path
simply does not exist in the next container, so the shortcut fails loudly
instead of quietly returning last week's list.

`MARKET_HOME` overrides the state directory. It is a **test hook only** — a
directory path, never a credential.

## Working on the template itself

The tools are run, never built. To typecheck them, install the dev-only types
first — and **delete `node_modules/` afterwards**: the registry check rejects
symlinks anywhere in a template, and a package manager's `.bin/` is full of
them.

```bash
cd home/grocery-list/tools
bun install && bunx tsc --noEmit -p tsconfig.json && bun test
rm -rf node_modules bun.lock          # before node scripts/check-templates.mjs
```

Environment knobs, all optional and all test/diagnostic hooks:

| Variable | Effect |
|---|---|
| `MARKET_HOME` | state directory (tests point this at their own temp dir) |
| `MARKETY_CLASSIFY_DISABLED=1` | never call the model; everything lands in the catch-all aisle |
| `MARKETY_CLASSIFY_MODEL` | override the classifier model |
| `MARKETY_CLASSIFY_TIMEOUT` | seconds per classifier call (default 8) |
| `TZ` | the container timezone, which is where the week boundary is read from |

---

Contributed by Amit Yanay — <https://github.com/CrAzyScreamx>
