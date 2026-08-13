---
name: hebrew-style
description: How to write Hebrew that renders correctly and sounds like a person wrote it — the RTL marks a chat client needs, gender handling without guessing, number agreement, Israeli date/time/currency formats, register, and a phrase bank. Use whenever you compose Hebrew yourself: a chat reply, a file caption, a question, a scheduled message, or Hebrew inside a document you generate. Do NOT use it on Hebrew a tool or command already rendered — that text is passed through untouched.
---

# Writing Hebrew

Two things go wrong with machine-written Hebrew, and they are independent. A line can be
grammatically perfect and still arrive scrambled, because chat clients lay out mixed
Hebrew/Latin/digit text by rules that have nothing to do with grammar. And a line can render
beautifully and still read as an obvious translation from English. §1 fixes the first; §2–§5
fix the second.

## What this applies to

**Hebrew you compose yourself** — replies, questions, captions, confirmations, proposals,
scheduled messages, Hebrew you put into a document you generate.

**Not** text a tool handed you: a rendered message already carries every mark it needs, so pass
it through byte-for-byte, and repeat the canonical name a command returned rather than the words
typed at you. **Not** `<internal>` blocks, logs, commit messages, or code — those stay English
and terse.

## 1. Rendering: the RTL marks

A chat client decides a line's direction from its **first strong directional character**, and it
merges adjacent Latin letters and digits into a single left-to-right run. Digits are
directionally weak and attach to whatever sits beside them. Together these wreck any Hebrew line
containing a number, a brand name, or a checkmark.

The fix is the **RTL mark** `‏` — U+200F, invisible, zero-width, strong right-to-left.

1. **Start every line with `‏`.** It forces the line right-to-left even when the line opens with
   a digit, a `✓`, or a Latin word.
2. **Put a quantity in parentheses directly after the noun** — `חלב (2 ליטר)`. Never separate
   them with a dash: `חלב — 2` puts a neutral character between Hebrew and a digit, and the
   number drifts to the far left, away from the thing it counts.
3. **After any Latin run, add `‏` before continuing** — `ביצים L‏ (4)`, not `ביצים L (4)`.
   Otherwise `L` and `4` fuse into one left-to-right run and the quantity reads as part of the
   product name. This is the most common way a Hebrew line breaks.
4. **Number list items `1.`, `2.`, `3.`** — never `#1`. A leading `#` is neutral and reorders.
5. **Never open a line with `•` or `-`.** Both are neutral; direction then comes from whatever
   follows, which may not be Hebrew.

**Never put `‏` inside a machine-read string** — a CLI argument, filename, JSON value, DB write,
URL, or code block. It is a real character; it will be stored and it will break the match later.
Prose only. Worked before/after examples, and how HTML/PDF differ: `references/rendering.md`.

## 2. Gender, without guessing

Hebrew inflects for the gender of both speaker and addressee, so an English sentence with no
gender in it becomes one you cannot write without picking a side. Impersonal constructions dodge
the reader's gender *and* your own, and they are what Israelis write in a service context:

| Instead of | Write |
|---|---|
| `אתה צריך לשלוח תמונה` | `יש לשלוח תמונה` |
| `את יכולה לאשר?` | `אפשר לאשר?` |
| `אני יכול לעזור לך?` | `איך אפשר לעזור?` |
| `אני בודק` / `אני מבין` | `בדקתי` / `הבנתי` |

First-person **past** tense carries no gender; present tense does. **You have no gender** —
never pick one for yourself. Where an imperative is natural, plural is always safe: `תשלחו`,
`תאשרו`, `תבדקו`. Slash notation (`שלח/י`, `את/ה`) once in a message is normal, three times
reads like a form.

**Never infer gender from a name.** If someone told you how to address them, or a tool owns that
fact, use it — otherwise stay impersonal. A wrong guess misgenders a real person in every
sentence; the impersonal form never does.

## 3. Counting: numbers 3–10 invert

The number form ending in `-ה` goes with **masculine** nouns. `שלושה פריטים` but `שלוש שורות`;
`שני דברים` but `שתי חבילות`. This looks backwards and getting it wrong is the clearest single
signal that software wrote the sentence. A digit in parentheses — `פריטים (3)` — sidesteps it
entirely, so the trap only bites prose you write freehand. Full table and the other grammar
tells (`כדי` vs `בכדי`, article contraction, final letters, nikud): `references/grammar.md`.

## 4. Tone

Informal and direct — דוגרי. Formal Hebrew in a chat reads as robotic; save it for government,
banking, and legal. **Cut the softeners:** write `לא הצלחתי לקרוא את הקבלה, תשלחו תמונה ברורה
יותר`, not `ייתכן שכדאי לשקול`. No `נשמח אם`, no `אנחנו מתנצלים על אי הנוחות`, no
`שאלה מעולה` — `תודה` and `סליחה` still belong. **Keep it short:** one answer, one confirmation,
one question; no preamble, no recap of what you just did. The translationese list and emoji
guidance: `references/tone.md`.

## 5. Formats

Dates `14/03/2026`; times 24-hour (`בשעה 14:30`); money `50 ש"ח` in prose; Western digits with
`,` thousands separators. Greetings change with the hour — `בוקר טוב`, `צהריים טובים`,
`ערב טוב`. `א'–ה'` is the work week, `ו'` is short, `שבת` is closed. Phones, abbreviations with
gershayim, relative time, and the Israeli calendar: `references/formats.md`.

## Before you send

- Does every line start with `‏`?
- Is there a Latin run without a closing `‏` after it?
- Any dash sitting between Hebrew and a digit?
- Did you write `אתה`/`את`, or gender yourself in the present tense?
- Counting in prose — is the number form the inverted one?
- Any softener, preamble, or `שאלה מעולה`?
- Is this one message, or did you write two?

## References

| File | What's in it |
|---|---|
| `references/rendering.md` | Before/after examples, mark hygiene, HTML/PDF `dir="rtl"` |
| `references/grammar.md` | Number table 1–10, `כדי`, contraction, final letters, nikud, numerals |
| `references/tone.md` | Register, softeners, translationese table, emoji, length |
| `references/formats.md` | Dates, times, money, phones, greetings, week, abbreviations |
| `references/phrases.md` | Phrase bank with transliterations and when each fits |
