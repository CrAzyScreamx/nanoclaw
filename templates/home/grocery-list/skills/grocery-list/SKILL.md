---
name: grocery-list
description: "Run the household shopping list: add items, show the list, mark things off, remove them, search, print it as a PDF or on paper, read a receipt photo, look at past weeks, and run the weekly rollover. Use whenever someone talks about the list, shopping, groceries, buying something, an item they need, a receipt, or printing the list."
---

# The shopping list

One CLI owns the list. You run a verb and forward what it printed — you never compose the
list, renumber it, or rebuild a confirmation from memory. This file routes you to the one
reference that covers the situation in front of you; read that reference before acting.

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts <verb>
```

Every verb takes `--help` (which touches nothing) and `--json`. **`--json` wraps the payload:
`{"ok":true,"data":…}` on success, `{"ok":false,"error":{…}}` on failure — read fields under
`data`.** Run `--help` for exact flags rather than guessing them.

## Verb cheat-sheet

| Verb | What it does |
|---|---|
| `add --name "<text>" [--qty <n>] [--unit "<u>"] [--note "<text>"]` | Put something on this week's list. Merges into a still-pending row for the same product: `--qty` is **added**, `--unit`/`--note` **overwrite** but only when passed. May answer `needs_confirmation` and write nothing |
| `add --confirm <token> --same-as <product-id>` \| `--new-product` | Answer that question. Never re-pass `--name`/`--qty`/`--unit`/`--note` |
| `message` | The chat message for this week's list. **Its stdout is the message** |
| `message --json` | The same items with both numbers: `n` (what the group sees) and `id` |
| `list` \| `list --all` \| `list --bought` \| `list --week current\|last\|<id>` | Working views, for your eyes only |
| `find --name "<part>"` | Substring search over this week's pending items |
| `mark-bought --n 2,3` \| `--id 47` | Mark bought by position, or by id from `message --json` / `find` |
| `remove --n 3` \| `--id 51` | Delete outright |
| `unmark --id 3` | Back to pending. `--id` only — a bought item has no position |
| `printable` | Render this week's list as an A4 PDF; stdout is the file path |
| `print` / `print --yes` | Paper. Without `--yes` it names the queue and page count and **refuses** |
| `report [--week …]` | One week: what was listed vs. bought |
| `pre-rotate` | The closing week's unbought items **without** rolling over |
| `rotate [--bought-n 1,3] [--carry-n 2,4 \| --carry all]` | Mark, roll the week, copy the carried items — one step |
| `weeks` | Week history with bought/total counts |
| `config` | The language, the week start, the receipt-corrections switch |
| `categories`, `categories --probe`, `recategorise`, `products …` | Operator verbs. Read-only to you unless someone asks for a repair |

## Hard rails

- **Every number the group sees is a position (`n`), never a row id.** A number quoted back
  at you goes to `--n`. `--id` is only for ids you read yourself. Full rule, and the one flow
  that uses `--id`: `references/positions-and-ids.md`. Getting this wrong marks or deletes
  the wrong item, silently.
- **Never send `list` or `find` output.** They are working views and they look unsendable on
  purpose. What the group sees comes from `message`, from `add --json`'s `confirm`, or from a
  file — nothing else.
- **Never edit the database by hand and never write SQL.** If the CLI cannot do it, say so.
- **Never write inside `/workspace/agent/plugins/grocery-list/`** — it is mounted read-only.
  All state is under `/workspace/agent/market/`, and the verbs own it.
- **Every image is read once, on its own, before anything touches the list** — by the
  receipt-reading subagent if this install has one, otherwise by you following
  `references/receipt-reader.md`. Either way you never write to the list off a reading the
  group has not confirmed.
- **`pre-rotate` and `rotate` belong to the three weekly tasks and nothing else.** Never
  rotate, and never send a rollover or reminder message, on your own initiative.
- **Paper is never the default reading of "print".** An ambiguous request produces the PDF.
  See `references/printable-list.md`.
- **Write in the configured language** — `config --json` names it. Text a verb handed you is
  passed through byte-for-byte; only your own prose is yours to write.

## Plays → references

| The situation | Read |
|---|---|
| "What's on the list", "show me the list", anything that puts the whole list in a message | `references/showing-the-list.md` |
| A number appeared — in their message or in yours; `--n` vs `--id`; what may be numbered | `references/positions-and-ids.md` |
| Someone named something to buy, with or without a quantity; fixing an item already listed | `references/adding-items.md` |
| `add` answered `needs_confirmation`; a token; "is this the same product?" | `references/product-matching.md` |
| "Printable", "PDF", "print it", or plainly wanting it on paper | `references/printable-list.md` |
| An image arrived; a receipt reading came back; marking items off a receipt | `references/receipts.md` |
| Which week an item is in; carry-over; a past week; what the weekly tasks do | `references/weekly-cycle.md` |
| The list speaks Hebrew and you are writing a line yourself | `references/hebrew-scope.md` |

If two rows seem to fit, take the one that names the *action* the user asked for.
