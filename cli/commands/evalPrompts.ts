import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { GeneratedFlow } from '../../packages/react-agent-intake/src/contracts.js';
import { loadConfig, readConfigFile, type AgentIntakeConfig } from '../../server/src/config.js';
import { EVAL_CALLS, loadCases, type EvalCall, type EvalCase } from '../../server/src/evals/cases.js';
import { countRuns, MAX_CONCURRENCY, runEvals, type EvalReport } from '../../server/src/evals/runEvals.js';
import { buildModel, resolveModelId, resolveProvider } from '../../server/src/llmClient.js';
import { isStaticMode } from '../../server/src/stepEngine.js';
import { resolveLogLevel } from '../../server/src/logger.js';
import { readFlowFile } from '../../server/src/trustedFlows.js';

// `agent-intake eval-prompts` (README: "Checking guidance with eval-prompts"): runs eval cases against the
// configured model, with the guidance from --config/--flow applied, so a
// change to guidance (or to the model) can be checked before it ships. It
// spends real model calls, so it says how many and asks first.

export interface EvalPromptsOptions {
  config?: string;
  flow?: string;
  cases?: string;
  /** false with --no-builtin: only the --cases directory. */
  builtin?: boolean;
  calls?: string;
  repeat?: string;
  minPass?: string;
  concurrency?: string;
  json?: boolean;
  yes?: boolean;
}

export interface EvalPromptsIO {
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_BELOW_MIN_PASS = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {}

/** evals/cases at the package root, found by walking up from this file (source or dist/). */
export function builtinCasesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'evals', 'cases');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new UsageError('The built-in eval cases (evals/cases) were not found.');
    dir = parent;
  }
}

function numberOption(value: string | undefined, name: string, check: (n: number) => boolean, rule: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} must be ${rule} (got "${value}").`);
  return n;
}

interface Prepared {
  cases: EvalCase[];
  calls?: EvalCall[];
  repeat?: number;
  minPass: number;
  concurrency: number;
  config: AgentIntakeConfig | null;
  flow: GeneratedFlow | null;
  provider: string;
  model: string;
}

// Everything that can be wrong with the command line, the files or the
// environment is found here, before any model call.
function prepare(options: EvalPromptsOptions): Prepared {
  const repeat = numberOption(options.repeat, 'repeat', (n) => Number.isInteger(n) && n >= 1 && n <= 50, 'a whole number from 1 to 50');
  const minPass = numberOption(options.minPass, 'min-pass', (n) => n >= 0 && n <= 1, 'a number from 0 to 1') ?? 0.9;
  const concurrency =
    numberOption(options.concurrency, 'concurrency', (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY, `a whole number from 1 to ${MAX_CONCURRENCY}`) ?? 1;
  let calls: EvalCall[] | undefined;
  if (options.calls !== undefined) {
    calls = options.calls.split(',').map((call) => call.trim()).filter(Boolean) as EvalCall[];
    const unknown = calls.filter((call) => !(EVAL_CALLS as readonly string[]).includes(call));
    if (calls.length === 0 || unknown.length > 0) {
      throw new UsageError(`--calls takes a comma-separated list of ${EVAL_CALLS.join(', ')} (got "${options.calls}").`);
    }
  }

  try {
    resolveLogLevel();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (isStaticMode()) {
    throw new UsageError(
      'AGENTINTAKE_STATIC_MODE is on, so every call would take its fallback path and the evals would only measure that. Unset it to run them.'
    );
  }
  // A bad LLM_PROVIDER or a missing key fails here, not on the first case.
  const provider = resolveProvider();
  buildModel(provider);

  const config = options.config ? readConfigFile(path.resolve(options.config)) : loadConfig();
  const flow = options.flow ? readFlowFile(path.resolve(options.flow)) : null;

  const cases = [
    ...(options.builtin === false ? [] : loadCases(builtinCasesDir())),
    ...(options.cases ? loadCases(path.resolve(options.cases)) : []),
  ];
  if (cases.length === 0) throw new UsageError('No eval cases to run: pass --cases, or drop --no-builtin.');
  const selected = calls ? cases.filter((c) => calls.includes(c.call)) : cases;
  if (selected.length === 0) throw new UsageError(`None of the cases are for ${calls!.join(', ')}.`);

  return { cases, calls, repeat, minPass, concurrency, config, flow, provider, model: resolveModelId(provider) };
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function formatReport(report: EvalReport, minPass: number, root: string): string {
  const versions = Object.entries(report.promptVersions)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ');
  const lines = [`Provider: ${report.provider}   Model: ${report.model}`, `Prompt versions: ${versions}`, ''];
  const row = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(17) : cell.padStart(9))).join('');
  lines.push(row(['Call', 'Runs', 'Passed', 'Rate', 'Degraded', 'p50', 'p95']));
  for (const [call, summary] of Object.entries(report.calls)) {
    const flag = summary.passRate < minPass ? `   below ${percent(minPass)}` : '';
    lines.push(
      row([call, String(summary.runs), String(summary.passed), percent(summary.passRate), String(summary.degraded), seconds(summary.p50Ms), seconds(summary.p95Ms)]) + flag
    );
  }
  const t = report.totals;
  lines.push(row(['Total', String(t.runs), String(t.passed), percent(t.passRate), String(t.degraded), '', '']));

  const failures = Object.entries(report.calls).flatMap(([call, summary]) => summary.failures.map((failure) => ({ call, ...failure })));
  if (failures.length > 0) {
    lines.push('', 'Failing runs:');
    for (const failure of failures) {
      const why = failure.degraded ? `fell back: ${failure.degradedReason}` : failure.reason;
      lines.push(`  ${failure.call} > ${failure.name} (run ${failure.run}, guidance ${failure.guidanceHash}): ${why}`);
      lines.push(`    ${path.relative(root, failure.file)}`);
      if (failure.got !== undefined) lines.push(`    got: ${JSON.stringify(failure.got)}`);
    }
  }
  return lines.join('\n');
}

/** Runs the command; returns the exit code. */
export async function runEvalPrompts(options: EvalPromptsOptions, io: EvalPromptsIO): Promise<number> {
  let prepared: Prepared;
  try {
    prepared = prepare(options);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const runs = countRuns(prepared);
  const plan =
    `This will run ${runs} eval case run(s) -- at least ${runs} model call(s), more if a generation is retried -- ` +
    `with ${prepared.provider} / ${prepared.model}.`;
  if (!options.yes) {
    if (!io.isTTY) {
      io.err(`${plan}\nRefusing to start without confirmation: there is no terminal to ask. Pass --yes to run anyway.`);
      return EXIT_USAGE;
    }
    const answer = (await io.ask(`${plan} Continue? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      io.err('Cancelled; no model calls were made.');
      return EXIT_OK;
    }
  } else if (!options.json) {
    io.err(plan);
  }

  let done = 0;
  let report: EvalReport;
  try {
    report = await runEvals({
      cases: prepared.cases,
      config: prepared.config,
      flow: prepared.flow,
      calls: prepared.calls,
      repeat: prepared.repeat,
      concurrency: prepared.concurrency,
      onRun: () => {
        done++;
        if (!options.json && io.isTTY) io.err(`\r${done}/${runs}`);
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }
  if (!options.json && io.isTTY) io.err('\n');

  io.out(options.json ? JSON.stringify(report, null, 2) : formatReport(report, prepared.minPass, process.cwd()));
  const below = Object.values(report.calls).some((summary) => summary.passRate < prepared.minPass);
  return below ? EXIT_BELOW_MIN_PASS : EXIT_OK;
}

function terminalIO(): EvalPromptsIO {
  return {
    isTTY: Boolean(process.stdin.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    out: (text) => process.stdout.write(text + '\n'),
    err: (text) => process.stderr.write(text.endsWith('\n') || text.startsWith('\r') ? text : text + '\n'),
  };
}

export function registerEvalPromptsCommand(program: Command): void {
  program
    .command('eval-prompts')
    .description('Run eval cases against the configured model, with your guidance applied (spends model calls)')
    .option('--config <path>', 'Config file with global guidance (default: agentintake.config.json or AGENTINTAKE_CONFIG)')
    .option('--flow <path>', 'flow.json whose flow and step guidance to apply (steps matched by endpoint id)')
    .option('--cases <dir>', 'A directory of your own cases (<dir>/<call>/*.json), run with the built-in ones')
    .option('--no-builtin', 'Run only the cases from --cases')
    .option('--calls <list>', `Only these calls, comma-separated: ${EVAL_CALLS.join(', ')}`)
    .option('--repeat <n>', "Runs per case (overrides each case's own repeat)")
    .option('--min-pass <rate>', 'Exit with code 1 if any call passes less than this (0 to 1)', '0.9')
    .option('--concurrency <n>', `Cases run at once, 1 to ${MAX_CONCURRENCY}`, '1')
    .option('--json', 'Print only the report, as JSON')
    .option('--yes', 'Run without asking for confirmation')
    // A bad option or argument is a usage error: exit code 2, like a bad file.
    .exitOverride((error) => process.exit(error.exitCode === 0 ? 0 : EXIT_USAGE))
    .action(async (opts: EvalPromptsOptions) => {
      process.exitCode = await runEvalPrompts(opts, terminalIO());
    });
}
