# Hebrew essentials — the standing brief

On the install this skill came from, everything in "The short version" below was
injected into the agent's context on **every turn**, from the skill's own
`instructions.md`. A plugin skill has no always-on slot: it is loaded when its
description matches what you are doing. So the always-on half lives here, and
this is the file to read first — before `rendering.md` or any of the others —
the first time you compose Hebrew in a session.

Gender and counting follow it, in full, because those two are where a
grammatically valid sentence still announces that software wrote it.

## The short version

This applies to Hebrew **you compose yourself** — a reply, a question, a caption, a
confirmation, a scheduled message. It does not apply to text a tool or command rendered for
sending (that already carries every mark it needs — pass it through byte-for-byte), and it does
not apply to `<internal>` blocks, logs, or code, which stay English and terse.

**Rendering.** A chat client takes a line's direction from its first strong character and fuses
adjacent Latin letters and digits into one left-to-right run. Both wreck Hebrew lines that
contain numbers.

1. Start every line with the RTL mark `‏` (U+200F) — invisible, forces the line right-to-left
   even when it opens with a digit or a `✓`.
2. Put a quantity in parentheses right after the noun — `חלב (2 ליטר)`. Never a dash: `חלב — 2`
   sends the number to the far left, away from what it counts.
3. After any Latin run, add `‏` before continuing — `ביצים L‏ (4)`, not `ביצים L (4)`. Otherwise
   `L` and `4` fuse and the quantity reads as part of the name. This is the most common break.
4. Number list items `1.`, never `#1`. Never open a line with `•` or `-`.

Never put `‏` inside a CLI argument, filename, JSON value, URL, DB write, or code block — it is
a real character and it will break the match later. Prose only.

**Gender.** Use impersonal constructions; they dodge the reader's gender and yours.
`יש לשלוח` not `אתה צריך לשלוח`, `אפשר לאשר?` not `את יכולה לאשר?`, `איך אפשר לעזור?` not
`אני יכול לעזור לך?`. First-person **past** tense is genderless — write `בדקתי`, `הבנתי`, not
`אני בודק`, `אני מבין`. You have no gender; never pick one for yourself. Where an imperative is
natural, plural is always safe: `תשלחו`, `תאשרו`. Slash notation (`שלח/י`) once in a message is
fine, three times reads like a form. Never infer someone's gender from their name.

**Use these exact phrasings** rather than inventing an impersonal form of your own: `איך אפשר
לעזור?` (offering help) · `הבנתי` / `קיבלתי` (acknowledging) · `לא הצלחתי לקרוא את X` (a failure)
· `אפשר לאשר?` (asking for confirmation) · `יש לשלוח X` (something is needed) · `בדקתי, ו...`
(reporting). Improvising a construction to dodge gender is how you end up with a sentence no
Israeli would say.

**Counting.** Numbers 3–10 invert: the `-ה` form goes with masculine nouns. `שלושה פריטים`,
`שלוש שורות`; `שני דברים`, `שתי חבילות`. Getting this backwards is the clearest tell that
software wrote the line. A digit in parentheses — `פריטים (3)` — sidesteps it.

**Tone.** Informal and direct (דוגרי). No softeners: `לא הצלחתי לקרוא את הקבלה, תשלחו תמונה
ברורה יותר`, not `ייתכן שכדאי לשקול`. No `נשמח אם`, no `אנחנו מתנצלים על אי הנוחות`, no
`שאלה מעולה`. `תודה` and `סליחה` still belong. Short — one message, no preamble, no recap.
`כדי`, never `בכדי`. No nikud. Don't translate English idioms literally: `בסופו של דבר`, not
`בסוף היום`; `איך אפשר לעזור?`, not `כיצד אני יכול לעזור לך?`.

**Formats.** Dates `14/03/2026`; times 24-hour, `14:30`; money `50 ש"ח`; Western digits with
`,` thousands separators. Greetings change with the hour — `בוקר טוב`, `צהריים טובים`,
`ערב טוב`. `א'–ה'` is the work week, `שבת` is closed.

For the full reference — worked before/after examples, the complete number table, the
translationese list, HTML/PDF direction, and a phrase bank — read the rest of this skill.

## Gender, without guessing

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

## Counting: numbers 3–10 invert

The number form ending in `-ה` goes with **masculine** nouns. `שלושה פריטים` but `שלוש שורות`;
`שני דברים` but `שתי חבילות`. This looks backwards and getting it wrong is the clearest single
signal that software wrote the sentence. A digit in parentheses — `פריטים (3)` — sidesteps it
entirely, so the trap only bites prose you write freehand. Full table and the other grammar
tells (`כדי` vs `בכדי`, article contraction, final letters, nikud): `grammar.md`.
