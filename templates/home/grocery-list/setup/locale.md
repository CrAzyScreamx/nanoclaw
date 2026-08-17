# Language and week start

Two decisions, one file. Both are settled here rather than in chat, because the language
shapes the aisle names the database seeds on its very first run, and the week start decides
which week an item added tonight belongs to.

## The file

`groups/<folder>/market/config.json` on the host, which the container sees at
`/workspace/agent/market/config.json`. The directory may not exist yet — the container
creates it on first run — so create it first. Nothing else in this template writes there
before the container starts.

```bash
mkdir -p groups/<folder>/market
cat > groups/<folder>/market/config.json <<'JSON'
{
  "locale": "he-IL",
  "weekStart": { "day": 3, "hour": 10 },
  "rememberReceiptCorrections": false
}
JSON
```

| Field | Meaning |
|---|---|
| `locale` | A tag shipped in `tools/locales/`. Today: `he-IL` (right-to-left) and `en-US` |
| `weekStart.day` | 0 = Sunday … 6 = Saturday. `3` is Wednesday |
| `weekStart.hour` | 0–23, in the **group's** timezone. `10` is 10:00 |
| `rememberReceiptCorrections` | Leave `false`. The welcome skill asks the group and sets it |

**Every field has a documented default** (`en-US`, Wednesday 10:00, `false`), so a missing
file or a missing field is not an error — writing the file just means the first list is
already right instead of being corrected later.

Re-running this overwrites the file, which is why `rememberReceiptCorrections` is worth
checking before you re-run it on a group that has been live: the group may have said yes, and
a blind re-write would quietly revoke that. Read the file first if it already exists.

## Verify

Once the container has run at least once, the CLI is the authority:

```bash
ncl groups restart --id <group-id> \
  --message "run: bun /workspace/agent/plugins/grocery-list/tools/grocery.ts config --json"
```

It reports the locale, the text direction, the week start as a readable label, and every
locale tag the template ships.

## Changing either one later

Both are safe to change on a live list, and neither loses data — but they are not symmetric:

- **Locale.** Aisles are matched on their pack `key`, never on their display name, so
  switching language **renames** the eleven aisles in place. Products keep their aisle, closed
  weeks keep their items, nothing is re-classified. What does *not* change is text already
  written: an item added as "milk" stays "milk", because a closed week keeps saying what it
  said. Change it from the container with `grocery.ts config --locale <tag>`, which re-seeds
  the display names as part of the write.
- **Week start.** The next boundary simply moves. An open week is not retimed and not closed
  early; the change takes effect the next time the boundary is crossed. **Retime the three
  weekly tasks to match** (`SETUP.md` step 2) — nothing links the cron schedules to this file,
  so a week start that moves without them leaves the rollover task firing at the wrong hour.

## Adding a language

One JSON file in `tools/locales/<tag>.json`, with the same keys as the two shipped packs:
`dir`, the eleven categories (ten aisles plus one flagged `catchAll`), every string
`render.ts` emits, every error line the print verbs relay, and the two classifier prompts.
`grocery.ts config --json` lists whatever it finds there, and an unknown tag fails naming the
tags that do exist. There is no code change and nothing to compile.
