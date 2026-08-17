#!/usr/bin/env bun
/**
 * campaign.ts — batch outbound calling: submit a recipient list, poll it, cancel it.
 *
 * The same confirm-before-dial rail as call.ts, at list scale: `submit` without
 * --yes prints the summary (count, a sample, persona, line, schedule) and exits
 * 6 without submitting anything.
 *
 * Campaign support is OPTIONAL on the VoiceProvider contract. A provider that
 * does not implement it simply has no submitCampaign/getCampaign/cancelCampaign
 * method, which is reported as an UnsupportedCapabilityError rather than a crash.
 *
 * No auth header is set: the OneCLI gateway injects by destination host.
 */
import {
  runTool,
  emit,
  flag,
  flagBool,
  formatTable as table,
  requireFlag,
  type CommandContext,
  type CommandSpec,
  type ToolSpec,
} from './lib/cli.ts';
import { getProvider } from './lib/registry.ts';
import {
  ConfirmationRequiredError,
  ExitCode,
  UnsupportedCapabilityError,
  VoiceToolError,
  type CampaignInput,
  type CampaignRecipient,
  type VoiceProvider,
} from './lib/provider.ts';
import { getLineConfig, readCampaign, saveCampaign } from './lib/state.ts';

const COMPLIANCE =
  'Compliance: outbound calling is regulated (TCPA in the US and local equivalents ' +
  'elsewhere). The recipient list, the consent behind it, and the calling hours are ' +
  "the operator's responsibility — not this tool's.";

// --------------------------------------------------------------------- helpers

function usage(message: string): VoiceToolError {
  return new VoiceToolError(message, { code: 'usage', exitCode: ExitCode.USAGE });
}

/** Splits one CSV line, honouring "quoted, fields" and doubled "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsv(text: string): CampaignRecipient[] {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rows.length < 2) {
    throw usage('The CSV needs a header row with a "number" column and at least one recipient.');
  }
  const header = splitCsvLine(rows[0]!).map((h) => h.toLowerCase());
  const numberAt = header.indexOf('number');
  if (numberAt === -1) {
    throw usage('The CSV header must contain a "number" column; every other column is a variable.');
  }
  return rows.slice(1).map((row, i) => {
    const cells = splitCsvLine(row);
    const number = cells[numberAt] ?? '';
    if (!number) throw usage(`Row ${i + 2} of the CSV has no number.`);
    const variables: Record<string, string> = {};
    header.forEach((name, at) => {
      if (at === numberAt || !name) return;
      const value = cells[at];
      if (value !== undefined && value !== '') variables[name] = value;
    });
    return Object.keys(variables).length ? { number, variables } : { number };
  });
}

function parseJson(text: string): CampaignRecipient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usage(`The recipients file is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw usage('The recipients JSON must be an array of {"number": "+1…", "variables": {…}}.');
  }
  return parsed.map((row, i) => {
    const rec = row as Partial<CampaignRecipient>;
    if (!rec || typeof rec.number !== 'string' || !rec.number) {
      throw usage(`Recipient ${i + 1} has no "number".`);
    }
    return rec.variables ? { number: rec.number, variables: rec.variables } : { number: rec.number };
  });
}

async function readRecipients(path: string): Promise<CampaignRecipient[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new VoiceToolError(`No recipients file at ${path}.`, {
      code: 'not_found',
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  const text = await file.text();
  const recipients = path.toLowerCase().endsWith('.csv')
    ? parseCsv(text)
    : text.trimStart().startsWith('[')
      ? parseJson(text)
      : parseCsv(text);
  if (recipients.length === 0) throw usage('The recipients file is empty.');
  return recipients;
}

/** unix seconds from an ISO-8601 timestamp, or null for "start now". */
function parseSchedule(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw usage(`--at expects an ISO-8601 timestamp, e.g. 2026-03-04T15:00:00Z — got "${value}".`);
  }
  return Math.floor(ms / 1000);
}

function requireCampaigns(provider: VoiceProvider): void {
  if (!provider.submitCampaign || !provider.getCampaign || !provider.cancelCampaign) {
    throw new UnsupportedCapabilityError(
      provider.name,
      'run calling campaigns on this install',
      'skills/voice-line/references/providers.md',
    );
  }
}

// ------------------------------------------------------------------- commands

const submitCommand: CommandSpec = {
  name: 'submit',
  summary: 'Submit a batch of outbound calls. Requires --yes.',
  usage:
    'campaign.ts submit --name <n> --line <lineId> --persona <personaId> ' +
    '--recipients <file.json|file.csv> [--at <iso8601>] [--yes] [--json]',
  async run(ctx: CommandContext) {
    const name = requireFlag(ctx.args, 'name');
    const lineId = requireFlag(ctx.args, 'line');
    const personaId = requireFlag(ctx.args, 'persona');
    const path = requireFlag(ctx.args, 'recipients');
    const scheduledAt = parseSchedule(flag(ctx.args, 'at'));
    const approved = flagBool(ctx.args, 'yes', false);
    const recipients = await readRecipients(path);

    const provider = await getProvider();
    requireCampaigns(provider);
    const line = getLineConfig(lineId);

    if (!approved) {
      const sample = recipients
        .slice(0, 5)
        .map((r) => `    ${r.number}${r.variables ? `  ${JSON.stringify(r.variables)}` : ''}`)
        .join('\n');
      throw new ConfirmationRequiredError(
        `Nothing has been submitted. Confirm the campaign with the user:\n` +
          `  name:       ${name}\n` +
          `  recipients: ${recipients.length} (from ${path})\n` +
          `${sample}${recipients.length > 5 ? `\n    …and ${recipients.length - 5} more` : ''}\n` +
          `  persona:    ${personaId}\n` +
          `  line:       ${line ? `${line.number} (${line.label || lineId})` : lineId}\n` +
          `  schedule:   ${
            scheduledAt ? new Date(scheduledAt * 1000).toISOString() : 'start immediately'
          }\n` +
          `${COMPLIANCE}\n` +
          'Re-run with --yes after the user says yes. Confirm the count and the sample, ' +
          'not every number.',
        'skills/voice-line/references/campaigns.md',
      );
    }

    const input: CampaignInput = { name, lineId, personaId, recipients, scheduledAt };
    const handle = await provider.submitCampaign!(input);
    const record = {
      id: handle.id,
      name: handle.name,
      status: handle.status,
      total: handle.total,
      lineId,
      personaId,
      scheduledAt,
      recipientsFile: path,
      submittedAt: Math.floor(Date.now() / 1000),
    };
    saveCampaign(handle.id, record);

    emit(ctx, { campaign: handle, record }, (d) => {
      console.log(`Submitted "${d.campaign.name}" (${d.campaign.id}).`);
      console.log(`  status:     ${d.campaign.status}`);
      console.log(`  recipients: ${d.campaign.total}`);
      console.log(`  record:     /workspace/agent/voice-line/campaigns/${d.campaign.id}.json`);
      console.log(`\nPoll it with: campaign.ts status ${d.campaign.id}`);
      console.log(COMPLIANCE);
    });
  },
};

const statusCommand: CommandSpec = {
  name: 'status',
  summary: 'Show a campaign: totals and per-recipient rows.',
  usage: 'campaign.ts status <campaignId> [--json]',
  async run(ctx: CommandContext) {
    const id = ctx.args.positionals[0];
    if (!id) throw usage('status needs a campaign id: campaign.ts status <campaignId>');
    const provider = await getProvider();
    requireCampaigns(provider);
    const status = await provider.getCampaign!(id);
    saveCampaign(id, {
      ...(readCampaign(id) ?? {}),
      status: status.status,
      dispatched: status.dispatched,
      completed: status.completed,
      failed: status.failed,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    emit(ctx, { campaign: status }, (d) => {
      const c = d.campaign;
      console.log(`${c.name}  (${c.id})`);
      console.log(
        `status ${c.status}  |  total ${c.total}  dispatched ${c.dispatched}  ` +
          `completed ${c.completed}  failed ${c.failed}`,
      );
      if (c.recipients.length) {
        console.log(
          '\n' +
            table(
              ['NUMBER', 'STATUS', 'CONVERSATION'],
              c.recipients.map((r) => [r.number, r.status, r.conversationId ?? '—']),
            ),
        );
      }
    });
  },
};

const cancelCommand: CommandSpec = {
  name: 'cancel',
  summary: 'Cancel a campaign that has not finished.',
  usage: 'campaign.ts cancel <campaignId> [--json]',
  async run(ctx: CommandContext) {
    const id = ctx.args.positionals[0];
    if (!id) throw usage('cancel needs a campaign id: campaign.ts cancel <campaignId>');
    const provider = await getProvider();
    requireCampaigns(provider);
    await provider.cancelCampaign!(id);
    saveCampaign(id, {
      ...(readCampaign(id) ?? {}),
      status: 'cancelled',
      cancelledAt: Math.floor(Date.now() / 1000),
    });
    emit(ctx, { id, status: 'cancelled' }, (d) => {
      console.log(
        `Cancelled campaign ${d.id}. Calls already in flight are not recalled — ` +
          'cancelling stops what has not been dispatched yet.',
      );
    });
  },
};

const spec: ToolSpec = {
  tool: 'campaign.ts',
  summary: 'Batch outbound calling: submit a recipient list, poll its progress, cancel it.',
  commands: [submitCommand, statusCommand, cancelCommand],
};

await runTool(spec, Bun.argv.slice(2));
