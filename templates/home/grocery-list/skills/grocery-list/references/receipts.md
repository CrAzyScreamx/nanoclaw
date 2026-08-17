# Images — read once, verify the reading, then write

**Every image is read by the receipt reader, as its own separate step, before
anything touches the list.**

When an image arrives it is saved to a path shown in the message. That path goes
to the reader and nowhere else yet.

**Who the reader is depends on this install, and you find out once:**

- **If a receipt-reading subagent exists here** — one named `receipt-ocr`, or
  whatever your runtime calls the same thing — hand it the path and do nothing
  else with the image. It runs on a stronger vision model than you, which is the
  whole reason to prefer it.
- **If there is none**, you are the reader. Follow
  `references/receipt-reader.md` on the image yourself, to the letter, and
  produce the same JSON object it describes. Then carry on below exactly as if a
  subagent had handed it to you.

Either way: do not decide from the caption, the sender, or the filename that an
image is probably a meme and skip the read — **whether an image is a receipt is
the reader's first job.** This holds for every image, every time, no matter how
clear or how obviously unrelated it looks.

And either way, **the reading is not a decision about the list.** Nothing is
marked, added or removed until the group has confirmed it. That is what keeps a
misreading to one question instead of a silent edit, and it is the part that
matters most when you are the reader yourself.

The reading is one JSON object carrying a `verdict`. There are three, and each
ends the turn differently.

**`{"verdict": "reject", "reason": "…"}` — not a receipt.** Say so in one short
line, using its `reason`, and stop. Nothing was read and nothing was recorded. No
matching, no list command, no follow-up question.

**`{"verdict": "unreadable", "reason": "…"}` — a receipt you cannot use.** Say so
and ask for a clearer photo. Do not guess at what it might have said.

**`{"verdict": "receipt", "confident": [...], "uncertain": [...]}` — proceed.**
The reading comes back as two lists. Items in `confident` carry `name`,
`quantity`, and `from_memory` — the printed receipt text a remembered correction
was keyed on, or `null` when the reader read the line off the page itself.
Items in `uncertain` carry `name` and `quantity` only; their `name` is a best
reading of text the reader could not settle.

**The split is the reader's, and only the reader's.** You never move an item
between the lists, never promote an `uncertain` line because the name looks
obvious to you, and never demote a `confident` one because it looks odd. You have
not seen the image; it has. There is no confidence number anywhere in this flow —
which list a line is in is the whole of it.

The order below is not negotiable, and the reason is that **the group's answer
can change any name on the receipt.** A name is what you match on, what you add
under, and what you remember. So nothing touches the list until the reading is
confirmed.

## 1. Send the reading back to be checked, and touch nothing else

This message asks one question — *did I read the receipt correctly?* — and it is
the whole turn. Do not run `message --json`, do not match anything against the
list, do not `add`, do not `mark-bought`. Matching a name the group is about to
correct is work you will have to throw away, and adding under it is work you
cannot.

One message, in the configured language, in this shape:

```
🧾 From the receipt:

milk 3%
melon ✎
white bread

❓ Needs checking:
«chse spred» — I could not read this

Is that all correct?

(✎ = filled in from memory, not read off the receipt)
```

- The `confident` items, one per line, in the order they came back. Carry the
  `quantity` in the same `(2)` shape the list uses whenever the receipt printed
  one — the count is part of the reading being checked, and a count nobody
  verified is a count you will add under later.
- **A `✎` after every item whose `from_memory` is not `null`**, and the legend
  line at the bottom whenever at least one `✎` appears. That marker is the
  group's only chance to catch a remembered correction that has gone stale: the
  word came out of memory, not off the page, and they are the only ones who can
  see the page.
- The `uncertain` items under their own heading, named as the reader read them
  and said plainly to be an unfinished reading rather than a fact.
- Omit either block entirely when it is empty, and never print an empty heading.

**Do not number any of these lines.** Every number the group sees is a position
on the list, and these are not list positions — a numbered receipt is a second
number space in the same conversation, and "number 2" stops having one answer.

**Close that turn's `<internal>` block with the state you will need later** — one
short English line per confident item: its name and its `from_memory` value, or
`none`; then the uncertain names. The answer arrives in a *later* turn, by which
point that JSON is well behind you, and both the memory step and the `✎`
accounting turn entirely on which readings came from memory. Writing it down now
is how it is still to hand when the answer comes.

## 2. Read the answer as a correction to the reading

Whatever the group says is the truth about the receipt, and it outranks anything
the reader returned. They may fix a name, resolve one of the uncertain lines,
tell you a line is not an item at all, or name something the reader missed
entirely.

Apply all of it, and treat the result as the receipt. An uncertain line the group
resolves becomes an ordinary item. An uncertain line they do not mention was
never confirmed — leave it out of everything that follows, and say so in one line
rather than quietly dropping it.

Until they answer, nothing happens. An unanswered receipt is not a stuck receipt:
the items are simply not marked yet, and that is a correct state to leave the
list in.

## 3. Remember what the reading got wrong — if the group asked you to

**This step is a setting.** `config --json` → `data.rememberReceiptCorrections`.
It is asked once, at first contact, and it is **off** unless the group said yes.

- **False** → skip this step entirely. Do not write to the memory tree, and do
  not offer to; they declined once and the answer stands until they raise it.
- **True** → do it **before you touch the list**. The group's answer carries all
  of it, so nothing here waits on the marking. Do it first, because once the
  items are written and the confirmation is sent the turn feels finished, and
  this is the step that gets left behind.

The reader has no memory of its own. It never sees this conversation and it
never sees what the group replies — the next receipt carrying a line it misread
goes better only because this turn left something behind. Three things are worth
keeping:

- **A line the group corrected that did not come from memory** — the text as the
  reader read it, and the item it actually names.
- **A `✎` line the group let stand** — that remembered correction held.
- **A `✎` line the group corrected anyway** — that remembered correction was
  wrong, and what it should have been instead.

Every `✎` on the receipt comes out of this step one way or the other — it held,
or it was wrong. "The group said nothing about it" is a finding you make, not a
step you skip.

Write it into the group's memory tree: the entries go in
`/workspace/agent/memory/receipts.md`, and `/workspace/agent/memory/index.md`
must carry a Markdown link to that file. That link is not decoration — the
reader reads `index.md` first and follows the links it finds, so an entry in a
file nothing points at is an entry nothing will ever read. Keep each entry keyed
on the **printed text as the reader read it**, with the item it actually names
beside it.

## 4. Now match against the list, and write

Run `message --json` for the candidates — it gives every pending item with both
numbers on it, `n` (what the group sees) and `id` (what the CLI takes), so you
never reconcile the two yourself. `find` helps for a specific name. Match on
meaning, not exact strings: receipts use abbreviations, brand names, and store
shorthand. This matching is your job, not the reader's.

Each confirmed item is one of three things:

- **On the list** → collect its `id` and run `mark-bought --id`. This is the one
  flow that uses `--id`, and the reason is the wait in step 1: positions resolve
  against the list *as it is when the command runs*, so anything added or removed
  between your message and their answer shifts every `n` under it. Ids do not
  move.
- **Not on the list** → it was bought without being listed, so put it on and mark
  it. `add --json` following the ordinary rules in `references/adding-items.md` —
  the receipt's count in `--qty` only when one was printed, qualifiers in `--note`
  — then `mark-bought --id` with the `id` from that add's item.
- **Already marked bought this week** → nothing to do. Check `list --bought
  --json` before adding anything, because `message --json` shows only pending
  items, and a second receipt for the same shop would otherwise add a duplicate
  row beside the one already marked.

An `add` that comes back `needs_confirmation` is **not** added and **not**
marked. Hold its token and leave the item alone; it is answered in step 6.

## 5. Reply once

What happened: what was marked off the list, what was added and marked, and
anything you left out because the group never confirmed it. If step 6 has
questions, they go in this same message, after the confirmations — one message
per request, as always.

## 6. Ask about the held items, one question per item

A `needs_confirmation` means the receipt's wording looks like a product the list
already knows under different words. Ask about each held item, naming only its
**first** candidate — the strongest match — in the shape
`references/product-matching.md` uses.

When the answer comes, run `add --json --confirm <token> --same-as <product-id>`
or `add --json --confirm <token> --new-product` for that item, then `mark-bought
--id` with the `id` from that call's item — it was bought, which is why it is
here at all. That is what `--json` is for here: the confirming call is the only
place the new row's id appears. Match each answer to its own token, and if an
answer is unclear, ask which item it was about rather than picking. An unanswered
question costs nothing: the item is simply not on the list yet, and the token
stays valid for a day.

**Never decide one of these yourself.** `add --same-as` teaches the CLI a
phrasing permanently, and receipt text carries sizes and percentages that are not
part of a product's identity — a receipt line taught to the CLI would resolve a
future *typed* name to the wrong product with no question asked. So `--same-as`
is reachable from the receipt path in exactly one way: as the group's direct
answer to the question above. Never from your own judgment about whether two
names look like the same thing.

---

**Never write to the list without confirmation.** OCR mistakes are expected, and
a reading in the `confident` list is not a promise. A wrong reading the group
corrects is free; silently clearing items off their list, or adding a
hallucinated one and marking it bought, is not. The split decides what you
*show* them, never what you *write*.
