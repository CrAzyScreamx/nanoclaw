# Adding items

The user will often add several things in one message, sometimes with
quantities and sometimes without. Call `add` once per item. A missing quantity
is fine — do not interrogate the user for one.

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts add --json \
  --name "<exactly what they said>" [--qty <n>] [--unit "<unit>"] [--note "<text>"]
```

**Always run `add` with `--json`.** The reply you send comes out of that JSON, in
a `confirm` object, already written in the configured language with every mark in
place. Plain `add` prints a working view instead — `#` ids, no RTL marks — which
is for reading, never for sending.

**Never "correct" an item name on the way in.** Pass `--name` exactly as the user
said it: keep their spelling, keep their apostrophes, and do not normalise it
toward the "proper" word. Their words are how the CLI learns a phrasing, so they
are data, not prose. What comes back *out* is a different matter — the list
stores the product's canonical name, and that is what your confirmation says.

**Never pass `--qty 1` yourself to stand in for an unstated count.** A new item
with no `--qty` is already stored as 1 — "add milk" means one milk, and the sheet
says `(1)` without you doing anything. Typing it out is not harmless: the same
`add` merges when the name is already on the list, and there `--qty` is *added*
to the current count, so a stray `--qty 1` turns 2 into 3. Pass `--qty` only when
the user actually named a number.

## The confirmation is not yours to compose

Each `add --json` returns a `confirm` object holding the finished reply (under
`data` in the `--json` envelope):

| Field | What it is |
|---|---|
| `confirm.line` | The whole reply for this one item. Send it as-is. |
| `confirm.item` | Just the item's line, for stacking under a shared header. |
| `confirm.header` | The header line to put above stacked items. |
| `confirm.verb` | `added`, `merged`, or `updated`. |

Two rules cover every case:

- **One item** → send its `confirm.line`.
- **Several items** → send the first call's `confirm.header`, then each call's
  `confirm.item`, one per line, in the order you ran them. A call that came back
  `"verb": "updated"` never stacks — send its `confirm.line` on its own, because
  nothing was added to the count and the header would say otherwise.

Everything the shape used to require of you is already inside those strings: the
invisible RTL marks where the language needs them, the mark that opens the line,
the canonical product name, the merge tail that says what the count is now, and
the new-product marker on a product the list has never seen. Send the string. Do
not retype it, do not translate it, do not restyle it, and never rebuild one of
these lines from memory — that is where a `5%` note and an RTL mark go missing,
exactly as they used to with the list itself.

## Quantity, unit, note — three different things

**Preserve product qualifiers; they are not quantities.** When the user names
something that says *which* product they mean — a fat percentage (`5%`, `3%`), a
size or weight (`250 g`, `1 litre`, `large`), or a variety (`wholemeal`, `low
sodium`) — carry it into `--note`. Only a count goes in `--qty`; everything else
that describes the product goes in `--note`.

There is one middle case, and it has its own flag. When the user names a count
*and* the unit that count is measured in — "two litres of milk", "four units" —
pass the unit as `--unit`: `--qty 2 --unit "litre"` renders inside the
parentheses where it belongs. Use `--unit` **only** alongside a real count. A
weight with no count, like `250 g`, is a qualifier and stays in `--note`;
splitting it into `--qty 250 --unit "g"` would make the next merge add 250 to the
count.

Never drop a `5%` or a `250 g` just because the same sentence also had a number —
the count and the qualifier are different things. This bites hardest with voice
notes, where the qualifier and the count arrive in one breath: "one cottage
cheese 250 grams, five percent" is **one** item — `--name "cottage cheese" --note
"250 g 5%"` — not two items, and not a bare `250 g` with the `5%` lost.

## Editing an item already on the list

The CLI has no edit verb. To change an existing item's note or fix a dropped
qualifier, run `add` again with the **same name** and the **full** `--note` you
want it to end up with: a matching name merges in place, and `--note` overwrites
the stored value — but only when you actually pass it; omitting `--note` leaves
the old one alone rather than clearing it. Pass `--qty` **only** when you truly
mean to add to the count — on a merge `--qty` is *added* to the current quantity,
so re-adding an item with `--qty 1` silently turns 1 into 2. When you are only
correcting a note, omit `--qty`.

This works only while the item is still **pending** in this week. Once it has
been marked bought, a re-add does not merge into it — it creates a second row,
and the list then shows the item twice.

## When `add` writes nothing

Sometimes `add` answers `needs_confirmation` instead of adding, because the name
looks like a product already on file under different words. Nothing was written.
`references/product-matching.md` has that whole flow.
