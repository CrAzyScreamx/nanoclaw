# Printable list — PDF, and the one that costs paper

When the user asks for a **printable** list — "printable list", "print it",
"PDF", "send me the list to print" — produce an A4 PDF and send it as a file. Do
not paste the list as text as well; the file is the answer.

**Those same words are the trigger for the `printing` skill, which puts a job on
a real printer. Here they mean the PDF.** Paper costs ink and cannot be undone,
so never start a physical print off an ambiguous request.

Run one command:

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts printable
```

Then:

- **It printed a path** → send that file with `send_file` and a one-line caption
  in the configured language, and close the turn. The caption *is* the reply;
  there is no message block in this turn, and nothing follows the file.
- **It printed nothing and failed** → relay the line it wrote on stderr, as-is,
  and stop. That line covers both an empty list and a real failure. Do not retry,
  and do not fall back to sending the list as text without saying the PDF failed.

**Never pass `--json` here.** `printable --json` prints the sorted payload and
renders **no PDF at all** — it is for checking how a list will be grouped, not
for producing a file.

## Send only the path this command printed in this turn

Every request for a printable list means running the command again — the list
changes between requests, and a sheet from an earlier turn shows the wrong one.
Never send a PDF path you are recalling from earlier in the conversation, and
never treat "I already sent this list today" as a reason to skip the command.

Nothing stops you here: rendered sheets sit under `/tmp/grocery-sheets/` for ten
minutes before they are reaped, so a path from a few minutes ago still exists and
`send_file` will happily deliver last request's list. Only running the command
again gets you the current one.

## The sheet is not yours to design

The command reads this week's pending items itself, sorts them into supermarket
aisles, carries each item's quantity and note onto the page, and sizes the sheet
to fit. **Do not build the print payload by hand and do not call
`tools/lib/printable.ts` directly** — that path is the renderer's own interface,
and going through it means re-deciding by hand everything the command already
gets right.

If an item lands in the wrong aisle, or under the catch-all when it should not,
say so in one line and leave it. An aisle is decided once per product, by a
model, and then stored — stored rather than recomputed precisely so the same list
cannot sort two different ways on two consecutive prints. Correcting one is
`grocery.ts recategorise`, an operator verb, not something to work around by
assembling the payload yourself.

## Paper

Paper has its own verb, and it is deliberately hard to trigger by accident:

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts print          # names the queue and page count, then refuses
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts print --yes    # submits exactly one job
```

- **An ambiguous "print" is the PDF.** Only a plain statement that paper is
  wanted gets anywhere near this verb.
- **Ask once, then submit.** Run `print` without `--yes`, show what it said — the
  queue and the page count — and wait for an explicit yes. That yes covers **that
  one job**, not the session: a second request, a re-print, a corrected list all
  need a fresh one.
- **The success line is `data.text`. Send that and nothing else.** Do not build a
  sentence out of `queue`, `pages` or `copies`, and **never quote the job id** — it
  is an operator's handle for `lpstat`, it means nothing to the group, and in a
  chat it reads like an error code. Same rule as everywhere else here: the CLI
  writes the line, you forward it. Composing one produced
  `✓ שלחתי להדפסה: 1 עמודים לcode canon (job canon-13)` — mangled, half in English,
  and leading with the one detail nobody asked for.
- `print` re-renders the list itself. That is why it takes no path: a
  predictably-named artifact is exactly what lets a print skip the render and put
  last request's list on paper.
- If it exits non-zero, relay the line it printed. "No printer is configured" and
  "`lp` is not installed" are both real, expected answers here — printing is
  optional at setup — and neither is something to work around. The `printing`
  skill's `references/errors.md` says what each one means.
