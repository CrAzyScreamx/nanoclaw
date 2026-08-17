# Reference: placing a call

One call, one confirmation. A phone call reaches a real person and cannot be
unsaid, so the confirmation is not a formality.

## The confirmation protocol

Before anything is dialed, **say back** — in your own message, not just in the
tool output:

1. **who** is being called (the person or business, as the user described them),
2. **the number**, digit for digit, in E.164,
3. **which persona speaks**, by name,
4. **every dynamic variable value** that will be substituted into the prompt.

Then **wait for an explicit yes**. "Go ahead", "yes", "call them" is a yes.
Silence is not. A new topic is not. A thumbs-up emoji is, if the user sent it in
answer to your question.

**One yes covers one call.** A corrected number, a retry after no-answer, a
second attempt with a changed variable — each needs a **fresh** yes. Never carry
an approval forward.

The tool enforces this: `call.ts dial` without `--yes` **does not dial**. It
prints the confirmation block and exits 6. That is the refusal working, not an
error to route around.

## The command

```bash
bun /workspace/agent/plugins/voice-agent/tools/call.ts dial \
  --to "+15550000000" \
  --line <lineId> \
  --persona <personaId> \
  --var customer_name=Dana \
  --var order_ref=A17 \
  --yes
```

- `--to` is E.164: leading `+`, country code, no spaces or dashes.
- `--line` comes from `lines.ts list`. The **carrier is resolved from the line**
  and never defaulted — you do not pass it.
- `--var k=v` repeats, once per dynamic variable the persona's prompt references.
  Values are substituted at call time; a variable the prompt does not mention is
  simply unused.
- Run it once **without** `--yes` to produce the confirmation block, show that to
  the user, then re-run **with** `--yes` after they agree.

## After it returns

The tool returns when the provider **accepts** the call — not when the call
ends. It prints the conversation id and, when the provider returned one, the
carrier-side call sid.

**Never re-dial on silence.** Quiet means the call is still running. The outcome
arrives later, through the outbound sweep or from:

```bash
bun .../calls.ts show <conversationId> --transcript
```

If the user asks "did it work?" a minute later, check with `calls.ts show`.
Do not place a second call to find out.

## A scheduled task never dials

A task run has **no human in the turn**, so there is nobody to approve a call and
nobody to hear `ask_user_question`. In a task run: report what you found and
**propose** the call. The dial happens in a real conversation, with a real yes.

## Nothing enforces the confirmation but you

The confirmation above is a strong default in your instructions, not enforcement
— NanoClaw's own guard seam does not see a plain HTTPS call made from inside a
container, and no rule at the proxy is holding these requests. Nothing catches
a dial you place without asking. Treat the rule as binding on that basis.

The only ceiling that exists is the credit cap on the ElevenLabs key, and it
stops spend rather than stopping a call the user did not want.

## Common failures

| Symptom | What it means |
|---|---|
| 401/403 | The vault has no ElevenLabs entry, or the wrong value format. See `connect-provider.md`. |
| "No line with id …" | The line id is stale. Re-run `lines.ts list`. |
| The call connects but the persona says the wrong thing | A variable was missing or misspelled. Check the persona prompt with `personas.ts show`. |
| The call never ends | The persona has no `end_call` tool. See `ending-a-call.md`. |
