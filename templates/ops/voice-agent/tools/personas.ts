#!/usr/bin/env bun
/**
 * personas.ts — the voices that speak on the line: list, inspect, create, edit.
 *
 * A persona is the provider's voice agent: prompt, first message, language,
 * voice and tools. The `end_call` system tool is included by DEFAULT, because a
 * persona without one runs until the callee hangs up.
 *
 * This tool refuses to write SIP trunk configuration or digest credentials —
 * see refuseCredentialFlags() in lib/cli.ts for why that is structural, not a
 * policy choice.
 *
 * No auth header is set: the OneCLI gateway injects by destination host.
 */
import {
  runTool,
  emit,
  flag,
  flagBool,
  formatTable as table,
  refuseCredentialFlags,
  requireFlag,
  type CommandContext,
  type CommandSpec,
  type ToolSpec,
} from './lib/cli.ts';
import { getProvider } from './lib/registry.ts';
import {
  ExitCode,
  VoiceToolError,
  type PersonaInput,
} from './lib/provider.ts';

// ----------------------------------------------------------------- formatting

function stamp(unix: number | null): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

// ---------------------------------------------------------------- flag → input

/** `--prompt "text"` or `--prompt @/path/to/file` (the file is read verbatim). */
async function textOrFile(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!value.startsWith('@')) return value;
  const path = value.slice(1);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new VoiceToolError(`No such file: ${path}`, {
      code: 'not_found',
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  return await file.text();
}

const NO_END_CALL_WARNING =
  'WARNING: this persona has no `end_call` system tool. It cannot hang up by ' +
  'itself, so every call runs until the callee hangs up — and on a line whose ' +
  'carrier credential is not configured, nothing else can end it either. ' +
  'See references/ending-a-call.md.';

async function collectInput(
  ctx: CommandContext,
  opts: { requireName: boolean },
): Promise<Partial<PersonaInput>> {
  refuseCredentialFlags(ctx);
  const input: Partial<PersonaInput> = {};
  const name = opts.requireName
    ? requireFlag(ctx.args, 'name')
    : flag(ctx.args, 'name');
  if (name !== undefined) input.name = name;

  const prompt = await textOrFile(flag(ctx.args, 'prompt'));
  if (prompt !== undefined) input.prompt = prompt;

  const first = await textOrFile(flag(ctx.args, 'first-message'));
  if (first !== undefined) input.firstMessage = first;

  const language = flag(ctx.args, 'language');
  if (language !== undefined) input.language = language;

  const voice = flag(ctx.args, 'voice');
  if (voice !== undefined) input.voiceId = voice;

  // Present-or-absent matters on update: an unmentioned tool is left alone.
  if (ctx.args.flags['end-call-tool'] !== undefined) {
    input.endCallTool = flagBool(ctx.args, 'end-call-tool', true);
  }
  return input;
}

// ------------------------------------------------------------------- commands

const listCommand: CommandSpec = {
  name: 'list',
  summary: 'List every persona on the account.',
  usage: 'personas.ts list [--json]',
  async run(ctx: CommandContext) {
    const provider = await getProvider();
    const personas = await provider.listPersonas();
    emit(ctx, { personas }, (d) => {
      if (d.personas.length === 0) {
        console.log('No personas yet. Create one with personas.ts create --name "…" --prompt "…"');
        return;
      }
      console.log(
        table(
          ['ID', 'NAME', 'CREATED'],
          d.personas.map((p) => [p.id, p.name, stamp(p.createdAt)]),
        ),
      );
    });
  },
};

const showCommand: CommandSpec = {
  name: 'show',
  summary: 'Show one persona in full, including whether it can end a call itself.',
  usage: 'personas.ts show <personaId> [--json]',
  async run(ctx: CommandContext) {
    const id = ctx.args.positionals[0];
    if (!id) {
      throw new VoiceToolError('show needs a persona id: personas.ts show <personaId>', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
      });
    }
    const provider = await getProvider();
    const persona = await provider.getPersona(id);
    emit(ctx, { persona }, (d) => {
      const p = d.persona;
      console.log(`${p.name}  (${p.id})`);
      console.log(`created:       ${stamp(p.createdAt)}`);
      console.log(`language:      ${p.language || '—'}`);
      console.log(`voice:         ${p.voiceId ?? '— (provider default)'}`);
      console.log(`tools:         ${p.tools.length ? p.tools.join(', ') : '— none'}`);
      console.log(`end_call tool: ${p.hasEndCallTool ? 'yes' : 'NO'}`);
      console.log(`\nfirst message:\n  ${p.firstMessage || '—'}`);
      console.log(`\nprompt:\n${p.prompt || '  —'}`);
      if (!p.hasEndCallTool) console.log(`\n${NO_END_CALL_WARNING}`);
    });
  },
};

const createCommand: CommandSpec = {
  name: 'create',
  summary: 'Create a persona. The end_call system tool is included by default.',
  usage:
    'personas.ts create --name <n> --prompt <text|@file> [--first-message <text|@file>] ' +
    '[--language en] [--voice <voiceId>] [--no-end-call-tool] [--json]',
  async run(ctx: CommandContext) {
    const patch = await collectInput(ctx, { requireName: true });
    const input: PersonaInput = {
      ...patch,
      name: patch.name!,
      endCallTool: patch.endCallTool ?? true,
    };
    const provider = await getProvider();
    const persona = await provider.createPersona(input);
    const warnings = input.endCallTool ? [] : [NO_END_CALL_WARNING];
    emit(ctx, { persona, endCallTool: input.endCallTool, warnings }, (d) => {
      console.log(`Created persona ${d.persona.name} (${d.persona.id}).`);
      if (d.endCallTool) {
        console.log(
          'The `end_call` system tool is configured: it can hang up itself when its ' +
            'stopping conditions are met.',
        );
      }
      for (const w of d.warnings) console.log(w);
      console.log(`Assign it to a line with: lines.ts assign <lineId> ${d.persona.id}`);
    });
  },
};

const updateCommand: CommandSpec = {
  name: 'update',
  summary: 'Patch a persona. Only the flags you pass are changed.',
  usage:
    'personas.ts update <personaId> [--name <n>] [--prompt <text|@file>] ' +
    '[--first-message <text|@file>] [--language <l>] [--voice <voiceId>] ' +
    '[--end-call-tool | --no-end-call-tool] [--json]',
  async run(ctx: CommandContext) {
    const id = ctx.args.positionals[0];
    if (!id) {
      throw new VoiceToolError('update needs a persona id: personas.ts update <personaId> …', {
        code: 'usage',
        exitCode: ExitCode.USAGE,
      });
    }
    const patch = await collectInput(ctx, { requireName: false });
    if (Object.keys(patch).length === 0) {
      throw new VoiceToolError(
        'update needs at least one field to change. See personas.ts update --help.',
        { code: 'usage', exitCode: ExitCode.USAGE },
      );
    }
    const provider = await getProvider();
    const persona = await provider.updatePersona(id, patch);
    const warnings = patch.endCallTool === false ? [NO_END_CALL_WARNING] : [];
    emit(ctx, { persona, changed: Object.keys(patch), warnings }, (d) => {
      console.log(`Updated ${d.persona.name} (${d.persona.id}): ${d.changed.join(', ')}.`);
      for (const w of d.warnings) console.log(w);
    });
  },
};

const spec: ToolSpec = {
  tool: 'personas.ts',
  summary:
    'Voice personas: the prompt, first message, voice and tools that decide what the caller hears.',
  commands: [listCommand, showCommand, createCommand, updateCommand],
};

await runTool(spec, Bun.argv.slice(2));
