# Reference: calling campaigns

Batch outbound calling: one persona, one line, many numbers. Same rails as a
single dial, applied at list scale.

## Compliance, first

**Outbound calling is regulated** — TCPA in the US and local equivalents
elsewhere. The recipient list, the consent behind every number on it, the
calling hours and any do-not-call scrubbing are the **operator's**
responsibility. Say this once when a campaign is first discussed, not in every
message afterwards. If the user has not said where the list came from, ask.

## The recipients file

Two formats. Put the file under `/workspace/agent/voice-line/` — never inside
the plugin directory, which is read-only.

**JSON** — an array of recipients:

```json
[
  { "number": "+15550000001", "variables": { "customer_name": "Dana", "order_ref": "A17" } },
  { "number": "+15550000002", "variables": { "customer_name": "Sam",  "order_ref": "B04" } }
]
```

**CSV** — a `number` column plus one column per variable:

```csv
number,customer_name,order_ref
+15550000001,Dana,A17
+15550000002,Sam,B04
```

Every column other than `number` becomes a dynamic variable for that recipient,
with the header as the variable name. Empty cells are omitted rather than sent
as empty strings. Quoted fields and doubled `""` escapes are handled.

## Submit

```bash
bun /workspace/agent/plugins/voice-agent/tools/campaign.ts submit \
  --name "March renewals" \
  --line <lineId> \
  --persona <personaId> \
  --recipients /workspace/agent/voice-line/renewals.csv \
  --at 2026-03-04T15:00:00Z \
  --yes
```

`--at` takes an ISO-8601 timestamp; omit it to start immediately.

**Run it once without `--yes` first.** The tool prints the summary — count, the
first five numbers with their variables, the persona, the line and the schedule —
and refuses to submit. Show that to the user and wait for an explicit yes.

At list scale you confirm the **count and the sample**, not every number. What
the user is approving is: this many people, from this list, hearing this persona,
starting then. If the count is a surprise to them, stop.

On success the record is written to
`/workspace/agent/voice-line/campaigns/<id>.json` — id, name, status, total,
line, persona, schedule, and the source file path.

## Poll

```bash
bun .../campaign.ts status <campaignId>
```

Totals (`dispatched` / `completed` / `failed`) plus one row per recipient with
its status and conversation id. The local record is refreshed on every poll.

Poll on demand, not in a loop. Individual call outcomes also arrive through the
outbound sweep — see `working-results.md` — and pulling a transcript is
`calls.ts show <conversationId> --transcript` on the conversation id from the
recipient row.

## Cancel

```bash
bun .../campaign.ts cancel <campaignId>
```

Cancelling stops what has **not been dispatched yet**. Calls already in flight
are not recalled — say that plainly rather than implying everything stopped.
The local record is marked cancelled.

## If campaigns are unavailable

Campaign support is optional on the provider contract. A provider that does not
implement it produces an "cannot run calling campaigns on this install" refusal
naming the provider — not a crash. In that case the fallback is a sequence of
single `call.ts dial` calls, each with its own confirmation, which is
deliberately slower and worth saying so.
