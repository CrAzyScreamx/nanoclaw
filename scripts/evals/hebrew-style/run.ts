/**
 * A/B eval for the `hebrew-style` container skill.
 *
 * Each case is a task that forces one rule from the skill. Every case runs twice
 * against the same model: once with the skill's always-on fragment
 * (`container/skills/hebrew-style/instructions.md`) in the system prompt, once
 * without. Checks are deterministic regexes over the reply, so the only variable
 * between arms is the skill text.
 *
 *   pnpm exec tsx scripts/evals/hebrew-style/run.ts [--model <id>] [--case <id>] [--runs <n>]
 *
 * Writes results to scripts/evals/hebrew-style/results-<model>.json.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..', '..');
const FRAGMENT = path.join(REPO, 'container', 'skills', 'hebrew-style', 'instructions.md');

const BASE_SYSTEM = [
  'You are an assistant in an Israeli family WhatsApp group.',
  'Always reply in Hebrew.',
  'Output only the message text the group should see — no explanation, no quotes, no code fences.',
].join(' ');

type Check =
  | { type: 'require' | 'forbid' | 'forbidLineStart'; pattern: string; flags?: string; desc?: string }
  | { type: 'everyLineStartsWithRlm'; desc?: string }
  | { type: 'maxLines'; value: number; desc?: string };

interface Case {
  id: string;
  rule: string;
  prompt: string;
  checks: Check[];
}

const RLM = '‏';

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function runCheck(check: Check, output: string): { ok: boolean; desc: string } {
  switch (check.type) {
    case 'require': {
      const re = new RegExp(check.pattern, check.flags ?? 'u');
      return { ok: re.test(output), desc: check.desc ?? `require /${check.pattern}/` };
    }
    case 'forbid': {
      const re = new RegExp(check.pattern, check.flags ?? 'u');
      return { ok: !re.test(output), desc: check.desc ?? `forbid /${check.pattern}/` };
    }
    case 'forbidLineStart': {
      const re = new RegExp(`^${check.pattern}`, check.flags ?? 'u');
      // Strip leading marks before testing: a line may legitimately open with RLM.
      const ok = lines(output).every((l) => !re.test(l.replace(/^[‎‏⁨⁩]+/u, '')));
      return { ok, desc: check.desc ?? `no line starts with /${check.pattern}/` };
    }
    case 'everyLineStartsWithRlm': {
      const ls = lines(output);
      return {
        ok: ls.length > 0 && ls.every((l) => l.startsWith(RLM)),
        desc: check.desc ?? 'every line starts with U+200F',
      };
    }
    case 'maxLines': {
      const n = lines(output).length;
      return { ok: n <= check.value, desc: check.desc ?? `at most ${check.value} lines (got ${n})` };
    }
  }
}

async function ask(model: string, system: string, prompt: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      '--system-prompt',
      system,
      '--exclude-dynamic-system-prompt-sections',
    ],
    { cwd, maxBuffer: 1024 * 1024, timeout: 180_000 },
  );
  return stdout.trim();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const model = flag('model') ?? 'claude-haiku-4-5-20251001';
  const only = flag('case');
  const runs = Number(flag('runs') ?? '1');

  const fragment = fs.readFileSync(FRAGMENT, 'utf-8').trim();
  const allCases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf-8')) as Case[];
  const cases = only ? allCases.filter((c) => c.id === only) : allCases;
  if (cases.length === 0) throw new Error(`no case matching --case ${only}`);

  // Empty cwd: no project CLAUDE.md, no settings, nothing but the system prompt.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hebrew-eval-'));

  const arms = [
    { name: 'control', system: BASE_SYSTEM },
    { name: 'skill', system: `${BASE_SYSTEM}\n\n${fragment}` },
  ] as const;

  const jobs = cases.flatMap((c) =>
    arms.flatMap((arm) =>
      Array.from({ length: runs }, (_, run) => ({ case: c, arm: arm.name, system: arm.system, run })),
    ),
  );

  process.stderr.write(`Running ${jobs.length} generations (${cases.length} cases x 2 arms x ${runs}) on ${model}\n`);

  const results = await mapLimit(jobs, 6, async (job) => {
    let output = '';
    let error: string | undefined;
    try {
      output = await ask(model, job.system, job.case.prompt, cwd);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const checks = error ? [] : job.case.checks.map((ch) => runCheck(ch, output));
    process.stderr.write(
      `  ${checks.length > 0 && checks.every((c) => c.ok) ? 'PASS' : 'FAIL'}  ${job.arm.padEnd(7)} ${job.case.id}\n`,
    );
    return { ...job, system: undefined, output, error, checks };
  });

  // Report
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log('');
  console.log(`Model: ${model}   runs per arm: ${runs}`);
  console.log('');
  console.log(`${pad('case', 26)} ${pad('control', 10)} ${pad('skill', 10)} rule`);
  console.log('-'.repeat(100));

  const tally = { control: { pass: 0, total: 0 }, skill: { pass: 0, total: 0 } };
  for (const c of cases) {
    const cell = (arm: string): string => {
      const rows = results.filter((r) => r.case.id === c.id && r.arm === arm);
      const passed = rows.filter((r) => r.checks.length > 0 && r.checks.every((k) => k.ok)).length;
      tally[arm as 'control' | 'skill'].pass += passed;
      tally[arm as 'control' | 'skill'].total += rows.length;
      return `${passed}/${rows.length}`;
    };
    console.log(`${pad(c.id, 26)} ${pad(cell('control'), 10)} ${pad(cell('skill'), 10)} ${c.rule}`);
  }
  console.log('-'.repeat(100));
  const pct = (t: { pass: number; total: number }) => `${t.pass}/${t.total} (${Math.round((100 * t.pass) / t.total)}%)`;
  console.log(`${pad('TOTAL', 26)} ${pad(pct(tally.control), 10)} ${pad(pct(tally.skill), 10)}`);

  const failures = results.filter((r) => r.arm === 'skill' && (r.error || r.checks.some((k) => !k.ok)));
  if (failures.length > 0) {
    console.log('\nSkill-arm failures:\n');
    for (const f of failures) {
      console.log(`  ${f.case.id}${f.error ? ` — ERROR ${f.error}` : ''}`);
      for (const k of f.checks.filter((k) => !k.ok)) console.log(`    ✗ ${k.desc}`);
      console.log(`    output: ${JSON.stringify(f.output).slice(0, 400)}`);
    }
  }

  const outFile = path.join(HERE, `results-${model}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify({ model, runs, tally, results }, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO, outFile)}`);
  fs.rmSync(cwd, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
