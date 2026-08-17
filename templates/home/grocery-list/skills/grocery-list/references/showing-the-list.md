# Showing the list

When asked what needs buying — "what's on the list", "show me the list", "the
list" — run one command:

```
bun /workspace/agent/plugins/grocery-list/tools/grocery.ts message
```

**Its stdout is the message. Send it verbatim and send nothing else.** Do not
retype it, do not renumber it, do not add a sentence before or after it, and do
not restyle the heading. An empty list is not a failure — the command prints the
empty-list line in the configured language, and that line is the whole reply.

Composing this message is not your job. Retyping is where the invisible RTL
marks get dropped, where a `5%` note goes missing, and where the heading drifts
into whatever phrasing happened to be in recent conversation history. The command
gets all of it right every time; your part is to run it and pass the text
through.

The same holds anywhere else the whole list belongs in a message — after a
rotation, or when a user asks what is left. Run `message` and forward it.

## The new-product marker in the list

A line may end with the new-product marker — `— מוצר חדש ✨` / `— new product ✨`.
It means exactly one thing: **this is the first time that product has ever been on
a list.** The CLI decided the typed name was not any product on file and created a
new one, and it says so on the line so the group can see it happen.

Forward it like the rest of the line; never strip it and never add it yourself.
`message --json` carries the same fact as `is_new_product` on each item, so you
never have to read it back out of the text.

If someone questions a marked line — "that's the same as X", "we already have
that" — they are telling you two products should be one. That is a merge, and it is
**not** yours to do: say you have noted it and that an operator can join them
(`products merge`), or, if the marked item was simply added by mistake, offer to
remove it. Never invent an alias to paper over it. Teaching a phrasing is
permanent, and only the group's direct answer to the question `add` asked may do
it.

The marker disappears by itself the next time that product is listed, so a line
carrying it today is an ordinary line next week.

## When to use `list` instead

Use `list` only when you need to **read** the list yourself — checking whether
something is already on it. It prints a working view that says so on its first
line, numbered by row id with `#`, and with none of the RTL marks. It is for your
eyes, and pasting it into the group produces backwards, broken lines. If you
catch yourself about to send `list` output, the command you wanted was `message`.

For matching a receipt, reach for `message --json` instead: it carries both
numbers.

| Want | Verb |
|---|---|
| The message the group sees | `message` |
| Both numbers on every pending item | `message --json` → `data.items[].n` / `.id` |
| Everything this week, bought included | `list --all` |
| Only what has been bought | `list --bought` |
| Another week | `list --week last`, `message --week <id>`, `report --week last` |

`list` is always scoped to one week and defaults to the current one. Never
present a past week's items as if they were still on the list.

## The item name you repeat

**The item name you say back is the one a command handed you**, never the one
that was typed at you. The CLI resolves a typed phrasing to a *product* and
stores the product's canonical name — so a short nickname goes in and the full
product name is what lands on the list, on the sheet, and in your confirmation.
Read the name out of the command's output; never assume it is what you typed.
