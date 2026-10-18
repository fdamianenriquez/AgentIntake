import type { GeneratedFlow } from '../../../packages/react-agent-intake/src/contracts.js';
import type { AgentIntakeConfig } from '../config.js';
import { withDegradationCapture } from '../degradation.js';
import { guidanceHash } from '../llmLog.js';
import { generateFlow } from '../flowGenerator.js';
import { resolveModelId, resolveProvider } from '../llmClient.js';
import * as classifyFailurePrompt from '../prompts/classifyFailure.js';
import * as generationPrompt from '../prompts/generation.js';
import { GUIDANCE_BLOCK_VERSION, guidanceFor, type PromptGuidance } from '../prompts/guidance.js';
import * as invalidationPrompt from '../prompts/invalidation.js';
import * as selectFieldsPrompt from '../prompts/selectFields.js';
import * as validatePrompt from '../prompts/validate.js';
import { checkInvalidation, classifyFailure, isStaticMode, selectStepFields, validateStepSubmission } from '../stepEngine.js';
import { caseEndpoints, EVAL_CALLS, type EvalCall, type EvalCase } from './cases.js';

// Runs eval cases against the configured provider and model,
// through the real engine functions and the same guidance narrowing the
// routes use. A library, so Studio can run it too; the CLI is a thin wrapper.

export const MAX_CONCURRENCY = 4;

export interface RunEvalsOptions {
  cases: EvalCase[];
  /** Guidance for every case that has no fixtures of its own. */
  config?: AgentIntakeConfig | null;
  flow?: GeneratedFlow | null;
  /** Only these calls; default all. */
  calls?: readonly EvalCall[];
  /** Runs per case; overrides each case's own `repeat`. */
  repeat?: number;
  /** Cases run at once, 1 to 4; default 1. */
  concurrency?: number;
  /** Called after each run, e.g. for progress output. */
  onRun?: (run: EvalRun) => void;
  /** Once aborted, no new run starts; runs in flight finish and are reported. */
  signal?: AbortSignal;
}

export interface EvalRun {
  call: EvalCall;
  name: string;
  file: string;
  /** 1-based, among this case's runs. */
  run: number;
  passed: boolean;
  /** The engine fell back (timeout, invalid output, provider error): always a failure. */
  degraded: boolean;
  degradedReason?: string;
  /** Why the expectation wasn't met. */
  reason?: string;
  latencyMs: number;
  /** Short hash of the guidance block the run used ("none" without guidance), as in the logs. */
  guidanceHash: string;
  /** What came back, for failed runs. */
  got?: unknown;
}

export interface CallSummary {
  runs: number;
  passed: number;
  failed: number;
  degraded: number;
  passRate: number;
  p50Ms: number;
  p95Ms: number;
  /** The guidance hashes this call ran with, so a result can be tied to a guidance version. */
  guidanceHashes: string[];
  failures: Omit<EvalRun, 'call' | 'passed'>[];
}

export interface EvalReport {
  provider: string;
  model: string;
  promptVersions: Record<EvalCall, number> & { guidanceBlock: number };
  calls: Partial<Record<EvalCall, CallSummary>>;
  totals: { runs: number; passed: number; failed: number; degraded: number; passRate: number };
}

const PROMPT_VERSIONS = {
  generation: generationPrompt.PROMPT_VERSION,
  selectFields: selectFieldsPrompt.PROMPT_VERSION,
  validate: validatePrompt.PROMPT_VERSION,
  invalidation: invalidationPrompt.PROMPT_VERSION,
  classifyFailure: classifyFailurePrompt.PROMPT_VERSION,
};

/** How many runs (and so at least how many model calls) `runEvals` would make. */
export function countRuns(options: Pick<RunEvalsOptions, 'cases' | 'calls' | 'repeat'>): number {
  return selectedCases(options).reduce((total, c) => total + (options.repeat ?? c.repeat ?? 1), 0);
}

function selectedCases({ cases, calls }: Pick<RunEvalsOptions, 'cases' | 'calls'>): EvalCase[] {
  return calls ? cases.filter((c) => calls.includes(c.call)) : cases;
}

// ---------------------------------------------------------------------------
// Guidance: the case's fixtures, or the run's config and flow
// ---------------------------------------------------------------------------

function guidanceForCase(c: EvalCase, options: RunEvalsOptions): PromptGuidance | undefined {
  const config = c.fixtures ? c.fixtures.config : options.config;
  const flow = c.fixtures ? c.fixtures.flow : options.flow;
  const flowGuidance = flow ? { guidance: flow.guidance, outputLanguage: flow.outputLanguage } : undefined;
  // Step guidance is matched to the case's steps by endpoint id.
  const stepGuidance = new Map(flow?.endpoints.map((endpoint) => [endpoint.id, endpoint.guidance]) ?? []);
  // Invalidation is the one call whose prompt also carries the later steps'
  // guidance, as the route passes the edited step and every later one.
  const { subjects, others } = caseEndpoints(c);
  const steps = c.call === 'invalidation' ? [...subjects, ...others] : subjects;
  return guidanceFor(
    c.call,
    config?.guidance,
    flowGuidance,
    steps.map((step) => ({ title: step.title, guidance: stepGuidance.get(step.id) }))
  );
}

// ---------------------------------------------------------------------------
// One run: call the engine, then check the expectation
// ---------------------------------------------------------------------------

interface Outcome {
  degraded: boolean;
  got: unknown;
  /** Why the expectation failed; undefined when it holds. */
  mismatch?: string;
}

function missingAndUnexpected(names: string[], expect: { mustInclude?: string[]; mustExclude?: string[] }): string | undefined {
  const missing = (expect.mustInclude ?? []).filter((name) => !names.includes(name));
  const unexpected = (expect.mustExclude ?? []).filter((name) => names.includes(name));
  const parts = [
    missing.length ? `missing ${missing.join(', ')}` : '',
    unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : undefined;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

async function runOne(c: EvalCase, guidance: PromptGuidance | undefined): Promise<Outcome> {
  // Each branch narrows the case to its call; the loader checked that input
  // and expect match the call's schemas.
  switch (c.call) {
    case 'generation': {
      const { input, expect } = c as EvalCase<'generation'>;
      const { flow, ambiguousFields } = await generateFlow({ ...input, guidance });
      const ids = flow.endpoints.map((endpoint) => endpoint.id);
      const ambiguous = ambiguousFields.map((note) => note.fieldName);
      const absent = input.endpoints.map((endpoint) => endpoint.id).filter((id) => !ids.includes(id));
      const mismatch = absent.length
        ? `endpoints missing: ${absent.join(', ')}`
        : expect.ambiguousFields
          ? missingAndUnexpected(ambiguous, expect.ambiguousFields)
          : undefined;
      return { degraded: false, got: { endpoints: ids, ambiguousFields: ambiguous }, mismatch };
    }
    case 'selectFields': {
      const { input, expect } = c as EvalCase<'selectFields'>;
      const result = await selectStepFields({ ...input, guidance });
      const names = result.fields.map((field) => field.name);
      return { degraded: result.degraded, got: { fields: names }, mismatch: missingAndUnexpected(names, expect) };
    }
    case 'validate': {
      const { input, expect } = c as EvalCase<'validate'>;
      const result = await validateStepSubmission({ ...input, guidance });
      const fields = Object.keys(result.errors);
      let mismatch: string | undefined;
      if (result.valid !== expect.valid) mismatch = `valid was ${result.valid}, expected ${expect.valid}`;
      else if (expect.errorFields) {
        const wanted = expect.errorFields.fields;
        const ok = expect.errorFields.mode === 'exact' ? sameSet(fields, wanted) : wanted.every((name) => fields.includes(name));
        if (!ok) mismatch = `error fields were [${fields.join(', ')}], expected ${expect.errorFields.mode} [${wanted.join(', ')}]`;
      }
      return { degraded: result.degraded, got: { valid: result.valid, errors: result.errors }, mismatch };
    }
    case 'invalidation': {
      const { input, expect } = c as EvalCase<'invalidation'>;
      const result = await checkInvalidation({ ...input, guidance });
      const ids = result.affected.map((entry) => entry.endpointId);
      const mismatch =
        'affected' in expect
          ? sameSet(ids, expect.affected)
            ? undefined
            : `affected [${ids.join(', ')}], expected exactly [${expect.affected.join(', ')}]`
          : missingAndUnexpected(ids, expect);
      return { degraded: result.degraded, got: { affected: result.affected }, mismatch };
    }
    case 'classifyFailure': {
      const { input, expect } = c as EvalCase<'classifyFailure'>;
      const result = await classifyFailure({ ...input, guidance });
      let mismatch: string | undefined;
      if (result.classification !== expect.classification) {
        mismatch = `classification was ${result.classification}, expected ${expect.classification}`;
      } else if ('rollbackFromEndpointId' in expect && result.rollbackFromEndpointId !== expect.rollbackFromEndpointId) {
        mismatch = `rollbackFromEndpointId was ${result.rollbackFromEndpointId}, expected ${expect.rollbackFromEndpointId}`;
      }
      const { degraded: _degraded, ...got } = result;
      return { degraded: result.degraded, got, mismatch };
    }
  }
}

async function timedRun(c: EvalCase, run: number, options: RunEvalsOptions): Promise<EvalRun> {
  const started = performance.now();
  const guidance = guidanceForCase(c, options);
  let outcome: Outcome;
  let reasons: string[];
  try {
    // The engine reports why it fell back to this run's own capture, so
    // overlapping runs (or eval jobs) never mix their reasons.
    const captured = await withDegradationCapture(() => runOne(c, guidance));
    outcome = captured.result;
    reasons = captured.degradations.map((degradation) => degradation.message);
  } catch (error) {
    // Generation has no fallback: a failure throws.
    outcome = { degraded: true, got: undefined };
    reasons = [error instanceof Error ? error.message : String(error)];
  }
  const latencyMs = Math.round(performance.now() - started);
  const base = { call: c.call, name: c.name, file: c.file, run, latencyMs, guidanceHash: guidanceHash(guidance) };
  if (outcome.degraded) {
    return { ...base, passed: false, degraded: true, degradedReason: reasons.at(-1) ?? 'the engine fell back', got: outcome.got };
  }
  if (outcome.mismatch) return { ...base, passed: false, degraded: false, reason: outcome.mismatch, got: outcome.got };
  return { ...base, passed: true, degraded: false };
}

// ---------------------------------------------------------------------------
// The run and the report
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(runs: EvalRun[]): CallSummary {
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);
  const passed = runs.filter((run) => run.passed).length;
  return {
    runs: runs.length,
    passed,
    failed: runs.length - passed,
    degraded: runs.filter((run) => run.degraded).length,
    passRate: runs.length ? passed / runs.length : 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    guidanceHashes: [...new Set(runs.map((run) => run.guidanceHash))].sort(),
    failures: runs.filter((run) => !run.passed).map(({ call: _call, passed: _passed, ...rest }) => rest),
  };
}

export async function runEvals(options: RunEvalsOptions): Promise<EvalReport> {
  if (isStaticMode()) {
    throw new Error(
      'AGENTINTAKE_STATIC_MODE is on, so every call would take its fallback path and the evals would only measure that. Unset it to run them.'
    );
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
  }
  const provider = resolveProvider();

  const tasks = selectedCases(options).flatMap((c) =>
    Array.from({ length: options.repeat ?? c.repeat ?? 1 }, (_, i) => ({ c, run: i + 1 }))
  );
  const runs: (EvalRun | undefined)[] = new Array(tasks.length);

  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !options.signal?.aborted) {
      const index = next++;
      runs[index] = await timedRun(tasks[index].c, tasks[index].run, options);
      options.onRun?.(runs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  const finished = runs.filter((run): run is EvalRun => run !== undefined);

  const calls: Partial<Record<EvalCall, CallSummary>> = {};
  for (const call of EVAL_CALLS) {
    const ofCall = finished.filter((run) => run.call === call);
    if (ofCall.length > 0) calls[call] = summarize(ofCall);
  }
  const passed = finished.filter((run) => run.passed).length;
  return {
    provider,
    model: resolveModelId(provider),
    promptVersions: { ...PROMPT_VERSIONS, guidanceBlock: GUIDANCE_BLOCK_VERSION },
    calls,
    totals: {
      runs: finished.length,
      passed,
      failed: finished.length - passed,
      degraded: finished.filter((run) => run.degraded).length,
      passRate: finished.length ? passed / finished.length : 0,
    },
  };
}
