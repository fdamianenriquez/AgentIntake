import { z } from 'zod';
import type { FieldDef, ParsedEndpoint } from '../../packages/react-agent-intake/src/contracts.js';
import { generateStructured } from './llmClient.js';
import * as classifyFailurePrompt from './prompts/classifyFailure.js';
import * as invalidationPrompt from './prompts/invalidation.js';
import { MAX_EXPLANATION_LENGTH, MAX_REASON_LENGTH } from './prompts/limits.js';
import * as selectFieldsPrompt from './prompts/selectFields.js';
import * as validatePrompt from './prompts/validate.js';

// Passed to generateStructured, which aborts the underlying request when it
// expires -- a stalled call stops costing quota, not just stops being awaited.
export const STEP_TIMEOUT_MS = 15_000;
// The invalidation check sends the edited step plus every later step's
// definition and answers, so it needs more time than a single step's call; a
// real run took 13.6s, too close to the 15s budget.
export const INVALIDATION_TIMEOUT_MS = 30_000;
// Failure classification also sends every completed step's definition and
// answers; with 15s the free-tier model never answered in live runs.
export const CLASSIFY_FAILURE_TIMEOUT_MS = 30_000;

// Providers drop maxLength from the JSON schema they enforce, so a model can
// write past a z.string().max() -- and that alone used to fail validation and
// throw away an otherwise correct answer. The prompt asks for less than the
// limit; text that still runs over is cut here instead of rejected.
function cappedText(max: number) {
  return z.string().transform((text) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`));
}

function isStaticMode(): boolean {
  const raw = process.env.AGENTINTAKE_STATIC_MODE;
  return raw !== undefined && raw !== '' && raw !== 'false' && raw !== '0';
}

// A dynamic enum of a specific endpoint's base field names. Because Zod can
// only ever validate a returned "name" to one of these literal values, an
// LLM response naming any field outside this set fails validation inside
// generateStructured -- this *is* the "no invented fields" guardrail
// (README: "The 'no invented fields' bound"), enforced structurally rather than by a
// post-hoc filter. Once a response passes this schema, every field name in
// it is provably one of the base fields.
function fieldNameEnum(fields: FieldDef[]) {
  const names = fields.map((field) => field.name);
  return z.enum(names as [string, ...string[]]);
}

// ---------------------------------------------------------------------------
// LLM call #2: adaptive field selection
// ---------------------------------------------------------------------------

export interface SelectStepFieldsInput {
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'description' | 'fields'>;
  previouslyCollectedData?: Record<string, Record<string, unknown>>;
}

export interface SelectStepFieldsResult {
  fields: FieldDef[];
  suggestedValues: Record<string, unknown>;
  /** True when the base (unfiltered) field list was used instead of an LLM-adapted one. */
  degraded: boolean;
}

export async function selectStepFields(input: SelectStepFieldsInput): Promise<SelectStepFieldsResult> {
  const baseFields = input.endpoint.fields;

  if (baseFields.length === 0) {
    return { fields: [], suggestedValues: {}, degraded: false };
  }

  if (isStaticMode()) {
    console.warn(`stepEngine: AGENTINTAKE_STATIC_MODE is on -- skipping adaptive field selection for "${input.endpoint.id}".`);
    return { fields: baseFields, suggestedValues: {}, degraded: true };
  }

  try {
    const outputSchema = z.object({
      fields: z.array(
        z.object({
          name: fieldNameEnum(baseFields),
          descriptionOverride: z.string().nullable(),
        })
      ),
      // A list of name/value pairs rather than a map keyed by field name: an
      // open-ended map is rejected by OpenAI's strict structured output.
      suggestedValues: z.array(
        z.object({
          name: fieldNameEnum(baseFields),
          value: z.union([z.string(), z.number(), z.boolean()]),
        })
      ),
    });

    const prompt = selectFieldsPrompt.build({
      endpoint: input.endpoint,
      baseFields,
      previouslyCollectedData: input.previouslyCollectedData ?? {},
    });
    const result = await generateStructured(prompt, outputSchema, { timeoutMs: STEP_TIMEOUT_MS });

    if (result.fields.length === 0) {
      return { fields: baseFields, suggestedValues: {}, degraded: true };
    }

    const baseByName = new Map(baseFields.map((field) => [field.name, field]));
    // A model can list the same field twice; each field is rendered once (a
    // repeated name would also mean duplicate element ids in the form).
    const seen = new Set<string>();
    const adaptedFields = result.fields
      .filter((entry) => !seen.has(entry.name) && seen.add(entry.name))
      .map((entry) => {
        const base = baseByName.get(entry.name)!; // guaranteed to exist: entry.name passed the enum above
        return entry.descriptionOverride ? { ...base, description: entry.descriptionOverride } : base;
      });

    // Suggestions only for fields actually shown: a value for a hidden or
    // unknown field would otherwise be submitted without the user seeing it.
    const suggestedValues = Object.fromEntries(
      result.suggestedValues.filter((entry) => seen.has(entry.name)).map((entry) => [entry.name, entry.value])
    );

    return { fields: adaptedFields, suggestedValues, degraded: false };
  } catch (error) {
    logDegradation('selectStepFields', input.endpoint.id, error);
    return { fields: baseFields, suggestedValues: {}, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// LLM call #3: semantic validation
// ---------------------------------------------------------------------------
//
// This returns the semantic verdict only -- it never calls execute().
// useAgentForm(flow: FlowDef, ...) is handed the full FlowDef (execute
// included) directly, and getAuthHeaders (a live function flowing into
// execute()'s context) only makes sense if execute() runs in the same
// process as the hook -- i.e. the browser. The server can
// never hold or call a client-defined execute(); it can only tell the
// client whether the submitted data passed the semantic check. Calling
// execute() and marking the step complete is the client's job, once
// it sees a positive verdict from this function (via the /api/step/validate
// route).

export interface ValidateStepSubmissionInput {
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'fields'>;
  data: Record<string, unknown>;
  previouslyCollectedData?: Record<string, Record<string, unknown>>;
}

export interface ValidateStepSubmissionResult {
  valid: boolean;
  errors: Record<string, string>;
  /** True when the semantic check was skipped/failed and the data was accepted by default. */
  degraded: boolean;
}

export async function validateStepSubmission(
  input: ValidateStepSubmissionInput
): Promise<ValidateStepSubmissionResult> {
  const { endpoint, data } = input;

  // Nothing to semantically validate either way -- same as selectStepFields,
  // this takes priority over static mode: with zero fields there was never
  // going to be an LLM call, static or not, so this isn't a "degraded" path.
  if (endpoint.fields.length === 0) {
    return { valid: true, errors: {}, degraded: false };
  }

  if (isStaticMode()) {
    console.warn(`stepEngine: AGENTINTAKE_STATIC_MODE is on -- skipping semantic validation for "${endpoint.id}".`);
    return { valid: true, errors: {}, degraded: true };
  }

  try {
    const outputSchema = z.object({
      valid: z.boolean(),
      errors: z.array(
        z.object({
          name: fieldNameEnum(endpoint.fields),
          message: z.string(),
        })
      ),
    });

    const prompt = validatePrompt.build({ endpoint, data, previouslyCollectedData: input.previouslyCollectedData ?? {} });
    const result = await generateStructured(prompt, outputSchema, { timeoutMs: STEP_TIMEOUT_MS });

    if (!result.valid) {
      const errors = Object.fromEntries(result.errors.map((entry) => [entry.name, entry.message]));
      return { valid: false, errors, degraded: false };
    }

    return { valid: true, errors: {}, degraded: false };
  } catch (error) {
    logDegradation('validateStepSubmission', endpoint.id, error);
    // degraded means "skip the semantic check and accept the data by
    // default" -- it is not a rejection.
    return { valid: true, errors: {}, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// LLM call #5: cross-step invalidation
// ---------------------------------------------------------------------------

type StepSummary = Pick<ParsedEndpoint, 'id' | 'title' | 'description' | 'fields'>;

export interface CheckInvalidationInput {
  editedEndpoint: StepSummary;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Steps after the edited one that are currently complete, in flow order. */
  laterCompletedEndpoints: StepSummary[];
  /** What was submitted for those later steps, by endpoint id. */
  laterData?: Record<string, Record<string, unknown>>;
}

export interface CheckInvalidationResult {
  affected: { endpointId: string; reason: string }[];
  /** True when the check couldn't run and every later step was flagged to be safe. */
  degraded: boolean;
}

const EVERY_LATER_STEP_REASON = 'An earlier answer changed; check that this step still applies.';

/**
 * After a completed step is edited, decides which later completed steps the
 * change plausibly invalidates. Degrades toward the safe side: if the check
 * can't run (static mode, timeout, bad output), every later step is flagged.
 * The output schema only accepts ids of the later steps it was given, so the
 * model can't flag an earlier step or one that doesn't exist.
 */
export async function checkInvalidation(input: CheckInvalidationInput): Promise<CheckInvalidationResult> {
  const later = input.laterCompletedEndpoints;
  if (later.length === 0) return { affected: [], degraded: false };

  const everyLaterStep = () => later.map((endpoint) => ({ endpointId: endpoint.id, reason: EVERY_LATER_STEP_REASON }));

  if (isStaticMode()) {
    console.warn(`stepEngine: AGENTINTAKE_STATIC_MODE is on -- flagging every step after "${input.editedEndpoint.id}".`);
    return { affected: everyLaterStep(), degraded: true };
  }

  try {
    const outputSchema = z.object({
      affected: z.array(
        z.object({
          endpointId: z.enum(later.map((endpoint) => endpoint.id) as [string, ...string[]]),
          reason: cappedText(MAX_REASON_LENGTH),
        })
      ),
    });

    const result = await generateStructured(invalidationPrompt.build(input), outputSchema, {
      timeoutMs: INVALIDATION_TIMEOUT_MS,
    });

    // One entry per step, in flow order, whatever order the model used.
    const reasons = new Map(result.affected.map((entry) => [entry.endpointId, entry.reason]));
    const affected = later
      .filter((endpoint) => reasons.has(endpoint.id))
      .map((endpoint) => ({ endpointId: endpoint.id, reason: reasons.get(endpoint.id)! }));
    return { affected, degraded: false };
  } catch (error) {
    logDegradation('checkInvalidation', input.editedEndpoint.id, error);
    return { affected: everyLaterStep(), degraded: true };
  }
}

// ---------------------------------------------------------------------------
// LLM call #4: failure classification
// ---------------------------------------------------------------------------

export type FailureClassification = 'retryable' | 'needs-edit' | 'fundamental';

export interface OperationFailureInput {
  kind: 'network' | 'timeout' | 'http' | 'other';
  status?: number;
  message?: string;
}

export interface ClassifyFailureInput {
  failedEndpoint: StepSummary;
  failure: OperationFailureInput;
  /** Completed steps, in flow order -- the only ones an undo may start from. */
  completedEndpoints: StepSummary[];
  /** What was submitted for the failed step and the completed ones, by endpoint id. */
  stepData?: Record<string, Record<string, unknown>>;
}

export interface ClassifyFailureResult {
  classification: FailureClassification;
  explanation: string;
  /** The earliest completed step to undo (that step through the last completed one), or null. */
  rollbackFromEndpointId: string | null;
  degraded: boolean;
}

/**
 * Classifies a failed step that the deterministic pre-classifier couldn't
 * (an HTTP 4xx other than 401/408/429, or a repeated unexplained failure).
 * Degrades toward the safe side: if the check can't run, the failure is
 * treated as retryable and no undo is proposed.
 */
export async function classifyFailure(input: ClassifyFailureInput): Promise<ClassifyFailureResult> {
  const fallback: ClassifyFailureResult = {
    classification: 'retryable',
    explanation: 'The cause could not be determined automatically. You can try again, change your answers, or stop here.',
    rollbackFromEndpointId: null,
    degraded: true,
  };

  if (isStaticMode()) {
    console.warn(`stepEngine: AGENTINTAKE_STATIC_MODE is on -- not classifying the failure of "${input.failedEndpoint.id}".`);
    return fallback;
  }

  try {
    const completedIds = input.completedEndpoints.map((endpoint) => endpoint.id);
    const rollbackFrom =
      completedIds.length > 0 ? z.enum(completedIds as [string, ...string[]]).nullable() : z.null();
    const outputSchema = z
      .object({
        classification: z.enum(['retryable', 'needs-edit', 'fundamental']),
        explanation: cappedText(MAX_EXPLANATION_LENGTH),
        rollbackFromEndpointId: rollbackFrom,
      })
      .refine((value) => value.classification === 'fundamental' || value.rollbackFromEndpointId === null, {
        error: 'Only a fundamental failure can propose an undo.',
      });

    const result = await generateStructured(classifyFailurePrompt.build(input), outputSchema, {
      timeoutMs: CLASSIFY_FAILURE_TIMEOUT_MS,
    });
    return { ...result, degraded: false };
  } catch (error) {
    logDegradation('classifyFailure', input.failedEndpoint.id, error);
    return fallback;
  }
}

function logDegradation(fn: string, endpointId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`stepEngine: ${fn}("${endpointId}") degraded to the fallback path -- ${message}`);
}
