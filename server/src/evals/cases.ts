import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ParsedEndpointSchema, type GeneratedFlow } from '../../../packages/react-agent-intake/src/contracts.js';
import { readConfigFile, type AgentIntakeConfig } from '../config.js';
import type { PromptCall } from '../prompts/guidance.js';
import { readFlowFile } from '../trustedFlows.js';

// Eval cases (README: "Checking guidance with eval-prompts"): one JSON file per case, in
// <dir>/<call>/*.json, each with the input one LLM call takes and what a
// correct answer must satisfy. They are checked strictly when loaded, so a
// typo in a case fails before anything is sent to a model.

export const EVAL_CALLS = ['generation', 'selectFields', 'validate', 'invalidation', 'classifyFailure'] as const;
export type EvalCall = (typeof EVAL_CALLS)[number] & PromptCall;

const Endpoint = ParsedEndpointSchema.strict();
const StepData = z.record(z.string(), z.record(z.string(), z.unknown()));
const Names = z.array(z.string()).min(1);

const InputSchemas = {
  generation: z
    .object({ endpoints: z.array(Endpoint).min(1), specTitle: z.string().optional(), specDescription: z.string().optional() })
    .strict(),
  selectFields: z.object({ endpoint: Endpoint, previouslyCollectedData: StepData.optional() }).strict(),
  validate: z
    .object({ endpoint: Endpoint, data: z.record(z.string(), z.unknown()), previouslyCollectedData: StepData.optional() })
    .strict(),
  invalidation: z
    .object({
      editedEndpoint: Endpoint,
      before: z.record(z.string(), z.unknown()),
      after: z.record(z.string(), z.unknown()),
      laterCompletedEndpoints: z.array(Endpoint).min(1),
      laterData: StepData.optional(),
    })
    .strict(),
  classifyFailure: z
    .object({
      failedEndpoint: Endpoint,
      failure: z
        .object({
          kind: z.enum(['network', 'timeout', 'http', 'other']),
          status: z.number().int().optional(),
          message: z.string().optional(),
        })
        .strict(),
      completedEndpoints: z.array(Endpoint),
      stepData: StepData.optional(),
    })
    .strict(),
};

const IncludeExclude = z
  .object({ mustInclude: Names.optional(), mustExclude: Names.optional() })
  .strict()
  .refine((value) => value.mustInclude || value.mustExclude, { error: 'Give mustInclude, mustExclude or both.' });

const ExpectSchemas = {
  // Every input endpoint present in the output is always checked.
  generation: z.object({ ambiguousFields: IncludeExclude.optional() }).strict(),
  selectFields: IncludeExclude,
  validate: z
    .object({
      valid: z.boolean(),
      errorFields: z
        .object({ fields: Names, mode: z.enum(['exact', 'subset']) })
        .strict()
        .optional(),
    })
    .strict(),
  invalidation: z.union([z.object({ affected: z.array(z.string()) }).strict(), IncludeExclude]),
  classifyFailure: z
    .object({
      classification: z.enum(['retryable', 'needs-edit', 'fundamental']),
      rollbackFromEndpointId: z.string().nullable().optional(),
    })
    .strict(),
};

export type EvalInput<C extends EvalCall> = z.infer<(typeof InputSchemas)[C]>;
export type EvalExpect<C extends EvalCall> = z.infer<(typeof ExpectSchemas)[C]>;

function caseSchema<C extends EvalCall>(call: C) {
  return z
    .object({
      call: z.literal(call),
      name: z.string().min(1),
      input: InputSchemas[call],
      expect: ExpectSchemas[call],
      /** Runs of this case when the command doesn't set --repeat. */
      repeat: z.number().int().min(1).max(10).optional(),
      notes: z.string().optional(),
      /**
       * Guidance this case needs, as paths relative to the case file. When
       * set, it replaces the run's --config/--flow for this case: a case that
       * only passes with certain guidance is checked with that guidance.
       */
      fixtures: z.object({ config: z.string().optional(), flow: z.string().optional() }).strict().optional(),
    })
    .strict();
}

export interface EvalCase<C extends EvalCall = EvalCall> {
  file: string;
  call: C;
  name: string;
  input: EvalInput<C>;
  expect: EvalExpect<C>;
  repeat?: number;
  notes?: string;
  /** Loaded from `fixtures`; undefined when the case has none. */
  fixtures?: { config: AgentIntakeConfig | null; flow: GeneratedFlow | null };
}

function problems(error: z.ZodError): string {
  return error.issues.map((issue) => `  ${issue.path.join('.') || '(top level)'}: ${issue.message}`).join('\n');
}

/** Loads one case file; `call` is the directory it lives in. */
export function loadCaseFile(file: string, call: EvalCall): EvalCase {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const declared = (raw as { call?: unknown } | null)?.call;
  if (declared !== call) {
    throw new Error(`${file}: "call" is ${JSON.stringify(declared)}, but the file is in the "${call}" directory.`);
  }
  const parsed = caseSchema(call).safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not a valid ${call} case:\n${problems(parsed.error)}`);

  const { fixtures, ...rest } = parsed.data;
  const here = path.dirname(file);
  return {
    file,
    ...(rest as Omit<EvalCase, 'file' | 'fixtures'>),
    ...(fixtures
      ? {
          fixtures: {
            config: fixtures.config ? readConfigFile(path.resolve(here, fixtures.config)) : null,
            flow: fixtures.flow ? readFlowFile(path.resolve(here, fixtures.flow)) : null,
          },
        }
      : {}),
  };
}

/**
 * Loads every case under `dir` (one subdirectory per call). Anything else in
 * it -- an unknown subdirectory, a stray file, an invalid case -- is an error
 * naming the path.
 */
export function loadCases(dir: string): EvalCase[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir}: not a directory of eval cases.`);
  const cases: EvalCase[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) throw new Error(`${full}: expected only directories named after a call (${EVAL_CALLS.join(', ')}).`);
    if (!(EVAL_CALLS as readonly string[]).includes(entry)) {
      throw new Error(`${full}: unknown call "${entry}" (expected one of ${EVAL_CALLS.join(', ')}).`);
    }
    for (const name of readdirSync(full).sort()) {
      const file = path.join(full, name);
      if (!name.endsWith('.json')) throw new Error(`${file}: case files must be .json.`);
      cases.push(loadCaseFile(file, entry as EvalCall));
    }
  }
  return cases;
}
