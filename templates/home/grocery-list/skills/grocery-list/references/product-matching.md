# When an item might already be on file under another name

Sometimes `add` writes **nothing** and answers `needs_confirmation` instead.
That means the name looks like a product already known under different words —
"zero" when the list has been calling it "coca cola zero" for months. The item
has not been added, and it will not be until you answer.

The output hands you a **token** and up to four candidates, best first (under
`data` in the `--json` envelope: `data.token`, `data.candidates[]`, each with
`id` and `name`). Ask the group about the **first** candidate only — it is the
strongest match, and a question listing four is a question nobody answers
cleanly. Use exactly this shape, in the configured language:

```
❓ «<what they typed>» — I have this on file as «<the first candidate's name>».
Same product? (yes / different one)
```

Then answer with **one** of these two commands — never both, never neither:

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts add --json --confirm <token> --same-as <product-id>
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts add --json --confirm <token> --new-product
```

- **`--same-as`** — same thing, different words. Pass the id of the candidate
  you actually asked about, which is the first one in the output. It is a
  *product* id, not a row id. The item is added under the known product's name,
  and the phrasing is remembered permanently, so this question is asked **once
  ever** for that wording.
- **`--new-product`** — genuinely something else. It becomes a product of its
  own, and you confirm it with the new-product marker the `confirm` line carries.

## Three rules about the token

1. **Never re-pass `--name`, `--qty`, `--unit` or `--note` on a confirming
   call.** The token already carries all four, and the confirming call ignores
   those flags outright — passing them changes nothing. The point of the token
   is that a `5%` or a `250 g` never passes through your hands twice, so it can
   never be lost.
2. **Never invent a token.** Use only one an `add` actually printed. A token
   lasts a day, so the one you were handed before asking the group is still good
   when they answer — which is normally a later turn, not this one. An expired
   or unknown token fails loudly; that is the command telling you to run `add`
   again, not to guess.
3. **A token is not a number the group sees.** Never show it in a message, and
   never confuse it with a position or an id.

## Several items where one needs confirmation

Still **one** message. Add everything that went through, then ask about the rest
in the same message — confirmations first, then the question:

```
✓ Added:
milk (2)
bread (1)

❓ «zero» — I have this on file as «coca cola zero».
Same product? (yes / different one)
```

The confirmation lines are the `confirm.header` / `confirm.item` strings from the
adds that succeeded, unchanged. Only the question is yours to write.

When the answer comes back, run the confirming command and reply with the
`confirm.line` it returns for the item that was waiting. If the user answers
about several at once, match each answer to its own token — the tokens are in
the output of the adds you already ran, in the order you ran them.

If the user's answer is unclear ("yes" to a message that asked about two
products), ask which one rather than picking. An unanswered question costs
nothing: the item is simply not on the list yet, and the token stays valid for
a day.

## Never decide a `--same-as` yourself

`--same-as` teaches the CLI a phrasing **permanently**. A wrong one resolves
silently forever after, and nobody is ever asked again. A wrong "different
product" costs one duplicate row that anyone can see and fix. The two mistakes
are not the same size, which is why the question exists at all and why the
answer is always the group's, never your judgement about whether two names look
alike. This matters most on the receipt path, where the printed text carries
sizes and percentages that are not part of a product's identity — see
`references/receipts.md`.
