import { z } from 'zod';
import {
  AmbiguousFieldNoteSchema,
  type FieldDef,
  type FlowGenerationResult,
  type ParsedEndpoint,
} from '../../packages/react-agent-intake/src/contracts.js';
import { generateStructured, LlmTimeoutError } from './llmClient.js';
import * as generationPrompt from './prompts/generation.js';

// Generation sends the whole spec in one prompt and returns the whole flow, so
// it gets a much longer budget than the per-step calls in stepEngine.ts. Unlike
// those, there is no fallback to degrade to, so a stalled model has to surface
// as an error rather than leave the CLI or Studio waiting forever.
export const GENERATION_TIMEOUT_MS = 120_000;

export interface GenerateFlowInput {
  endpoints: ParsedEndpoint[];
  specTitle?: string;
  specDescription?: string;
}

// Structural guardrail, not a prompted promise (README: "The 'no invented
// fields' bound"): the LLM's output schema for each field accepts only
// "name" and optional "labelOverride"/"descriptionOverride" -- never "type", "required",
// "enumValues", or "validation". Those four are always reconstructed from
// the raw parsed field by looking it up by name (see expandLlmOutput below),
// exactly mirroring stepEngine.ts's fieldNameEnum + rehydration pattern.
//
// An earlier version of this guardrail asked the LLM for the whole FieldDef
// and only told it, in the prompt, not to change `validation` -- checking
// just the field *name* sets afterward. In real use (generating the demo's
// flow.json), that let a generation run silently corrupt a field's
// validation.pattern (dropped \s exclusions, an unescaped '.'), caught only
// because the non-negotiable human review step happened to catch it. This
// makes that failure mode structurally impossible instead of merely
// detectable after the fact.
// One schema shared by every endpoint entry, then a refinement that checks
// each entry's field names against THAT endpoint's own fields -- a field
// name valid on one endpoint is rejected if it shows up under a different
// endpoint's id. Not a z.discriminatedUnion: that becomes "oneOf" in the JSON
// schema sent to the provider, which some providers (Anthropic) reject
// outright. The refinement isn't sent to the model, but generateStructured
// validates every response against the full Zod schema, so it is enforced
// all the same.
function buildLlmOutputSchema(endpoints: ParsedEndpoint[]) {
  const ids = endpoints.map((endpoint) => endpoint.id);
  const allFieldNames = [...new Set(endpoints.flatMap((endpoint) => endpoint.fields.map((field) => field.name)))];
  const ownFieldNames = new Map(endpoints.map((endpoint) => [endpoint.id, new Set(endpoint.fields.map((field) => field.name))]));

  const endpointsSchema = z
    .array(
      z.object({
        id: z.enum(ids as [string, ...string[]]),
        title: z.string(),
        // Nullable, not optional: OpenAI's strict structured output requires
        // every property to be present.
        description: z.string().nullable(),
        fields: z.array(
          z.object({
            name: allFieldNames.length > 0 ? z.enum(allFieldNames as [string, ...string[]]) : z.never(),
            labelOverride: z.string().nullable(),
            descriptionOverride: z.string().nullable(),
          })
        ),
      })
    )
    .superRefine((entries, ctx) => {
      entries.forEach((entry, index) => {
        const own = ownFieldNames.get(entry.id)!;
        entry.fields.forEach((field, fieldIndex) => {
          if (!own.has(field.name)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'fields', fieldIndex, 'name'],
              message: `"${field.name}" is not a field of endpoint "${entry.id}".`,
            });
          }
        });
      });
    });

  return z.object({
    flow: z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      endpoints: endpointsSchema,
    }),
    ambiguousFields: z.array(AmbiguousFieldNoteSchema),
  });
}

type LlmOutput = z.infer<ReturnType<typeof buildLlmOutputSchema>>;

/**
 * LLM call #1: groups the mechanically-parsed endpoints into
 * one flow, orders them, and writes clear title/label/description text. The
 * LLM may only reword and reorder -- every other property is rehydrated
 * from the raw input, never trusted from the model (see above).
 */
export async function generateFlow(input: GenerateFlowInput): Promise<FlowGenerationResult> {
  const prompt = generationPrompt.build(input);
  const outputSchema = buildLlmOutputSchema(input.endpoints);

  const attempt = async (): Promise<FlowGenerationResult> => {
    const raw = await generateStructured(prompt, outputSchema, { timeoutMs: GENERATION_TIMEOUT_MS });
    return expandLlmOutput(raw, input.endpoints);
  };

  try {
    return await attempt();
  } catch (firstError) {
    // The retry exists for invalid output. A timeout isn't that, and retrying
    // would just double the wait for a model that's already not responding.
    if (firstError instanceof LlmTimeoutError) {
      throw new Error(`flowGenerator: ${firstError.message} Try again, or switch to a different model or provider.`);
    }
    try {
      return await attempt();
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`flowGenerator: failed to generate a valid flow after 2 attempts. Last error: ${message}`);
    }
  }
}

function expandLlmOutput(raw: LlmOutput, rawEndpoints: ParsedEndpoint[]): FlowGenerationResult {
  const rawById = new Map(rawEndpoints.map((endpoint) => [endpoint.id, endpoint]));
  const rawIds = [...rawById.keys()];
  const generatedIds = raw.flow.endpoints.map((endpoint) => endpoint.id);

  if (!sameSet(rawIds, generatedIds)) {
    throw new Error(
      `flowGenerator: generated flow's endpoint ids don't match the input (expected: ${rawIds.join(', ')}; got: ${generatedIds.join(', ')})`
    );
  }

  const endpoints = raw.flow.endpoints.map((endpoint) => {
    const rawEndpoint = rawById.get(endpoint.id)!; // guaranteed to exist: endpoint.id passed the id-set check above

    const rawFieldNames = rawEndpoint.fields.map((field) => field.name);
    const generatedFieldNames = endpoint.fields.map((field) => field.name);
    if (!sameSet(rawFieldNames, generatedFieldNames)) {
      throw new Error(
        `flowGenerator: endpoint "${endpoint.id}" fields don't match the input (expected: ${rawFieldNames.join(', ')}; got: ${generatedFieldNames.join(', ')})`
      );
    }

    const baseFieldsByName = new Map(rawEndpoint.fields.map((field) => [field.name, field]));
    const fields: FieldDef[] = endpoint.fields.map((entry) => {
      const base = baseFieldsByName.get(entry.name)!; // guaranteed: entry.name passed this endpoint's own field enum
      return {
        ...base,
        label: entry.labelOverride ?? base.label,
        description: entry.descriptionOverride ?? base.description,
      };
    });

    return {
      id: endpoint.id,
      title: endpoint.title,
      ...(endpoint.description !== null ? { description: endpoint.description } : {}),
      fields,
      // Rehydrated, never LLM-controlled -- same principle as type/required/etc.
      // (the no-invented-fields rule). The LLM output schema has no slot for
      // any of these, so a model can't add, drop or alter them.
      auth: rawEndpoint.auth,
      ...pickDefined(rawEndpoint, ['capabilities', 'resourcePath', 'idParam', 'pathParams']),
    };
  });

  return {
    flow: {
      id: raw.flow.id,
      title: raw.flow.title,
      description: raw.flow.description,
      endpoints,
    },
    ambiguousFields: raw.ambiguousFields,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

function pickDefined<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}
