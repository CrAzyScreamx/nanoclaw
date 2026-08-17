# Where the list's state lives

Four places, and the differences between them are not cosmetic.

- `/workspace/agent/plugins/grocery-list/` — the plugin: `tools/`, `skills/`, `SETUP.md`,
  `setup/`. **Mounted read-only.** Nothing is ever written there, by you or by a tool. A
  write attempt fails; treat one as a bug, not as a permission to work around.
- `/workspace/agent/market/` — the runtime state, read-write. The tools own it. **You may
  read any of it freely; let the verbs do the writing.** Hand-editing these files puts your
  notion of the list out of step with the database's.
- `/tmp/grocery-sheets/run-*/` — rendered PDFs, deliberately outside the group mount.
- `/workspace/agent/memory/` — the group's own notes. Only the receipt-corrections file
  below lives here, and only when that setting is on.

## `market/config.json` — the three settings

```json
{
  "locale": "he-IL",
  "weekStart": { "day": 3, "hour": 10 },
  "rememberReceiptCorrections": false
}
```

- `locale` — which language pack the CLI renders in, and the language you write in. Every
  shipped tag is listed by `config --json` under `locales`.
- `weekStart` — `day` is 0 = Sunday … 6 = Saturday, `hour` is 0–23, read in the container's
  own timezone. Nothing stores a timezone; `TZ` is the only source.
- `rememberReceiptCorrections` — off unless the group said yes at first contact.

Written by `config` and by the operator's `SETUP.md` before the container ever ran, always
atomically (temp file + rename), so a config file is never half-written. Defaults apply for
anything missing, so an absent file is not an error.

## `market/grocery.db` — the list itself

SQLite, in WAL mode, so `-wal` and `-shm` siblings sitting beside it are normal. Seven
tables, and the ownership rules that matter:

| Table | Holds | Note |
|---|---|---|
| `weeks` | one row per shopping week | closed weeks are kept; that is the history |
| `categories` | the eleven aisles | seeded from the locale pack; **no verb creates one** |
| `products` | the thing itself, and its aisle | `products.category_id` is the **only** owner of an aisle |
| `product_aliases` | the words people type for a product | one phrasing belongs to exactly one product |
| `items` | one purchase, in one week | has **no** `category_id`; an item's aisle resolves through its product |
| `pending_adds` | an `add` that asked a question instead of writing | one row per unanswered token, 24-hour TTL |
| `app_state` | the classifier's remembered auth shape and cooldown | diagnostics only |

`bootstrap` runs before every verb: it creates whatever is missing, re-seeds the aisle
display names from the active pack, drops expired tokens, and gives a bounded number of
uncategorised products another chance with the classifier. It is idempotent and it never
fails a verb because the classifier was unreachable.

## Which verb writes what

| Verb | Writes |
|---|---|
| `add` | `items` (a new row, or a merge into the pending one); `products` + `product_aliases` on a first sighting; `pending_adds` when it asks instead |
| `add --confirm` | consumes the `pending_adds` row, then writes as above |
| `mark-bought` / `unmark` / `remove` | `items` — status, or the row's existence |
| `rotate` | `weeks` (closes one, opens the next) and `items` (the carried **copies**) |
| `config` | `config.json`; `categories.name` when the locale changes |
| `recategorise` | `products.category_id` |
| `products rename` / `merge` / `alias` | `products`, `product_aliases`, and `items.name` in the open week only |
| `printable` / `print` | a PDF under `/tmp/grocery-sheets/`; nothing in the database |
| `message`, `list`, `find`, `report`, `weeks`, `pre-rotate`, `categories` | nothing — reads only |

Two of those are worth stating outright. **`pre-rotate` is the only read in the CLI that
does not trip the lazy week rollover**; every other verb, `list` included, closes an overdue
week as a side effect. And **carried items are copies** — the originals stay `pending` in
the closed week, because they genuinely were not bought.

## `/tmp/grocery-sheets/` — rendered PDFs, on purpose

One fresh directory per run, reaped on **every** invocation with a ten-minute TTL. The
placement is deliberate: under the group mount a sheet survives the container with a
predictable name, and the agent was observed sending that morning's file back without
rendering anything. Under `/tmp` a stale path simply stops existing, so the shortcut fails
instead of quietly delivering last week's list.

## `/workspace/agent/memory/receipts.md` — only if the group said yes

What a receipt reading got wrong, keyed on the printed text as it was read, with the item it
actually names. `memory/index.md` must carry a Markdown link to it: the receipt
reader reads the index first and follows the links it finds, so an unlinked file is never
read. Nothing else about a receipt is kept — no prices, no totals, no image.
