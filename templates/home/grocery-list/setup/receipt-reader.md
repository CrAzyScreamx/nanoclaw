# The receipt reader — install it for the provider you run

A photo of a receipt is read **once, by itself**, before anything touches the list. The brief
for that read ships with the template, provider-neutral, at

```
skills/grocery-list/references/receipt-reader.md
```

What differs between installs is not the brief — it is whether your provider can run it as a
separate agent. This step puts the right thing in place. It is optional: skip it and the
assistant follows the brief itself, which works, just less well (below).

## Why a separate reader at all

Two reasons, and only the first is about accuracy.

1. **Vision is the hardest thing this agent does.** The rest of the work is small — pick a
   verb, forward the CLI's output — which is why the model guidance in `SETUP.md` points at a
   small model. Reading a creased receipt in a language with no capital letters is the
   opposite, and a small model does not fail loudly at it: it returns plausible items that
   were never on the page.
2. **The split is structural.** The reader has no access to the list and cannot write to it,
   so a misreading can only ever become a question to the group — never a silent edit. That
   property survives even on an install where the reader is the same model as the assistant.

## If your provider has a subagent mechanism

Install the brief as one, on a **vision-capable model at least as strong as the assistant's**,
and give it read-only tools: file reading and text search over the workspace, nothing else. No
write access, no shell, no grocery CLI — the brief's whole contract is that it returns one JSON
object and stops.

**Claude Code** reads agent definitions from `groups/<folder>/.claude/agents/*.md`. Create
`receipt-ocr.md` there with frontmatter naming the model you want, and the brief as the body:

```bash
mkdir -p groups/<folder>/.claude/agents
{
  printf -- '---\n'
  printf 'name: receipt-ocr\n'
  printf 'description: Looks at ANY image sent to the group, decides whether it is a receipt, and if it is, transcribes its purchased line items into two lists — the readings it is sure of, and the readings it is not. Pass the image file path. The main assistant never reads an image itself.\n'
  printf 'tools: Read, Grep, Glob\n'
  printf 'model: <a vision-capable model>\n'
  printf -- '---\n\n'
  sed '1,/^---$/d' groups/<folder>/plugins/grocery-list/skills/grocery-list/references/receipt-reader.md
} > groups/<folder>/.claude/agents/receipt-ocr.md
```

The `sed` drops this template's own explanatory header, which is about installation and is not
part of the brief. Read the result before you rely on it.

**Any other provider:** the mechanism differs and some have none at all. Whatever the shape,
carry across two things and you have it right — the brief as the body, and read-only tools.
Name it `receipt-ocr` if the provider lets you, so the skills' wording matches what is there.

Do **not** put the model in the template. Templates carry no provider, model or effort; this
file is the only place that choice is written down, and it is written per install.

## If your provider has none

Nothing to do. The assistant reads the image itself, following the same brief out of the
skill. Say so plainly to whoever runs the group: receipt accuracy then tracks the assistant's
own model, so this is the one place where the small-model recommendation in `SETUP.md` costs
something real. A group that photographs receipts often is a group worth running on a larger
model, or worth revisiting this step on a provider that has subagents.

## Verify

Send one photo of a receipt to the group and watch what comes back. Correct behaviour is a
message listing what was read — confident items plainly, unreadable ones under their own
heading — and **a question**, not a changed list. If items were marked off before anyone
confirmed the reading, the brief is not being followed; check that whatever you installed
carries the whole body, not a summary of it.

An image that is not a receipt should come back as one short line saying so. That is the
reader doing its first job, and it is the reason every image is handed over rather than
guessed at from the caption or the filename.
