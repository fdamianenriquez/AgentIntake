import { z } from 'zod';
import type { FieldDef, ParsedEndpoint } from '../../packages/react-agent-intake/src/contracts.js';
import { generateStructured } from './llmClient.js';

// Passed to generateStructured, which aborts the underlying request when it
// expires -- a stalled call stops costing quota, not just stops being awaited.
export const STEP_TIMEOUT_MS = 15_000;
// The invalidation check sends the edited step plus every later step's
// definition and answers, so it needs more time than a single step's call; a
// real run took 13.6s, too close to the 15s budget.
export const INVALIDATION_TIMEOUT_MS = 30_000;

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
          descriptionOverride: z.string().optional(),
        })
      ),
      suggestedValues: z.record(z.string(), z.unknown()).default({}),
    });

    const prompt = buildSelectFieldsPrompt(input.endpoint, baseFields, input.previouslyCollectedData ?? {});
    const result = await generateStructured(prompt, outputSchema, { timeoutMs: STEP_TIMEOUT_MS });

    if (result.fields.length === 0) {
      return { fields: baseFields, suggestedValues: {}, degraded: true };
    }

    const baseByName = new Map(baseFields.map((field) => [field.name, field]));
    const adaptedFields = result.fields.map((entry) => {
      const base = baseByName.get(entry.name)!; // guaranteed to exist: entry.name passed the enum above
      return entry.descriptionOverride ? { ...base, description: entry.descriptionOverride } : base;
    });

    return { fields: adaptedFields, suggestedValues: result.suggestedValues, degraded: false };
  } catch (error) {
    logDegradation('selectStepFields', input.endpoint.id, error);
    return { fields: baseFields, suggestedValues: {}, degraded: true };
  }
}

function buildSelectFieldsPrompt(
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'description'>,
  baseFields: FieldDef[],
  previouslyCollectedData: Record<string, Record<string, unknown>>
): string {
  return `You are choosing which fields to show for one step of a multi-step intake wizard.

Step: "${endpoint.title}" (${endpoint.id})
${endpoint.description ? `Description: ${endpoint.description}\n` : ''}
Base fields for this step (JSON) -- you may only reference fields by the exact "name" values below, never invent a new one:
${JSON.stringify(baseFields, null, 2)}

Data already collected in earlier steps (JSON):
${JSON.stringify(previouslyCollectedData, null, 2)}

Task:
1. Decide which of the base fields are relevant to show right now, given what's already been collected. You may omit a field that's clearly irrelevant given an earlier answer (e.g. a field only relevant to one branch of a status field). Include at least one field.
2. Order "fields" in the most sensible order for the user to fill them out.
3. Optionally set "descriptionOverride" on a field to add helpful context based on earlier answers (e.g. referencing what was already collected). Omit it to keep the field's original description.
4. Optionally suggest confident pre-fill values in "suggestedValues", keyed by field name, only for fields you included in "fields" and only when already-collected data makes the value obvious.`;
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

    const prompt = buildValidatePrompt(endpoint, data, input.previouslyCollectedData ?? {});
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

function buildValidatePrompt(
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'fields'>,
  data: Record<string, unknown>,
  previouslyCollectedData: Record<string, Record<string, unknown>>
): string {
  return `You are validating one step's submitted data in a multi-step intake wizard, beyond basic client-side checks (format/range) that already passed before this was submitted.

Step: "${endpoint.title}" (${endpoint.id})

Fields (JSON):
${JSON.stringify(endpoint.fields, null, 2)}

Submitted data (JSON):
${JSON.stringify(data, null, 2)}

Data already collected in earlier steps (JSON):
${JSON.stringify(previouslyCollectedData, null, 2)}

Task: look for implausible values or inconsistencies a simple regex/range check can't catch (e.g. a start date far in the past for a new hire, a value inconsistent with an earlier answer). Only flag genuine problems -- do not invent stricter rules than the field descriptions imply.

Return "valid: true" with an empty "errors" array if nothing looks wrong. Otherwise return "valid: false" and one entry per problem in "errors", each with the exact field "name" (from the fields list above) and a short, user-facing "message".`;
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
          reason: z.string().max(240),
        })
      ),
    });

    const result = await generateStructured(buildInvalidationPrompt(input), outputSchema, {
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

function buildInvalidationPrompt(input: CheckInvalidationInput): string {
  const laterSteps = input.laterCompletedEndpoints.map((endpoint) => ({
    id: endpoint.id,
    title: endpoint.title,
    description: endpoint.description,
    fields: endpoint.fields.map((field) => ({ name: field.name, label: field.label, description: field.description })),
    submittedData: input.laterData?.[endpoint.id] ?? {},
  }));

  return `In a multi-step intake wizard, the user went back and changed a step they had already completed. Decide which of the LATER completed steps may no longer be correct because of that change.

Edited step: "${input.editedEndpoint.title}" (${input.editedEndpoint.id})
${input.editedEndpoint.description ? `Description: ${input.editedEndpoint.description}\n` : ''}
Values before the edit (JSON):
${JSON.stringify(input.before, null, 2)}

Values after the edit (JSON):
${JSON.stringify(input.after, null, 2)}

Later completed steps, with what was submitted for each (JSON):
${JSON.stringify(laterSteps, null, 2)}

Task: list in "affected" only the later steps whose submitted data, or whose set of relevant fields, plausibly depends on what changed (for example a name that must match, or fields that only apply to one account type). For each, give its exact "id" as "endpointId" and a short, user-facing "reason". Return an empty list if the change doesn't affect any later step.`;
}

function logDegradation(fn: string, endpointId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`stepEngine: ${fn}("${endpointId}") degraded to the fallback path -- ${message}`);
}
