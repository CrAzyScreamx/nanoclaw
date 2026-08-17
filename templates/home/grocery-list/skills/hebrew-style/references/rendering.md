# Rendering Hebrew: worked examples

The five rules are in `SKILL.md` §1. This is what they look like in practice and where the
edges are.

## Before and after

| Written | Arrives as |
|---|---|
| `חלב — 2` | quantity torn off to the far left of the line |
| `‏חלב (2 ליטר)` | `חלב (2 ליטר)` — intact |
| `ביצים L (4)` | `L (4)` reads as one blob glued to the product name |
| `‏ביצים L‏ (4)` | `ביצים L (4)` — the `(4)` stays a quantity |
| `#3 קוטג'` | number reorders away from the item |
| `‏3. קוטג'` | `3. קוטג'` — intact |
| `50 - ₪` | symbol and amount separate |
| `‏50 ש"ח` | `50 ש"ח` — intact |
| `✓ נקנה` | `✓` is neutral, so the line's direction is a coin flip |
| `‏✓ נקנה` | `✓ נקנה` — intact |

## Mark hygiene

- **One `‏` per job.** Line start, and after each Latin run. Sprinkling extras through a
  sentence does nothing visible and leaves text that won't match a search or a diff.
- **A pure-Hebrew line with no digits and no Latin needs no marks** — the first Hebrew letter is
  already strong RTL. A leading `‏` is harmless, so adding one everywhere is the cheap default
  when composing many lines at once.
- **Never inside a machine-read string.** CLI arguments, filenames, JSON values, DB writes,
  URLs, code blocks, regexes. It is a real character; it gets stored and it breaks the match
  later. Prose a human reads, nothing else.
- **Emoji are neutral too.** An emoji mid-line can shift a nearby number. Put it at the end of
  the line, or leave it out of any line you had to mark.
- **If a line still arrives wrong**, it is almost always rule 3: a Latin run you didn't close.
  Second most likely: a dash between Hebrew and a digit.

## Mixed-direction content

- Brand names, CLI verbs, model names, and file names stay Latin — just close them with `‏`.
- A bare URL in a Hebrew line is a long LTR run; put it on its own line rather than mid-sentence.
  A line that is only a URL needs no mark.
- Parentheses and brackets are neutral and mirror automatically once the line's direction is
  right, so `(2 ליטר)` needs no special handling beyond the leading mark.

## HTML and PDF

Different mechanism — marks are not it. Set `dir="rtl"` on the outermost container **as a markup
attribute**, not only `direction: rtl` in CSS: a parent framework's `direction: ltr` outranks a
stylesheet rule but not the attribute. Set it on inputs and on each text block individually.
Hebrew then flows correctly with no invisible characters, and the marks above become noise inside
the document — leave them out.

For a rendered-to-PDF page, check the output itself rather than the markup: rasterize a page and
look at it. A container without CJK/Hebrew-capable fonts renders tofu (empty rectangles), which
looks nothing like a direction bug but gets misdiagnosed as one.
