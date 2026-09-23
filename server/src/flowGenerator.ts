import { z } from 'zod';
import { GeneratedFlowSchema, type GeneratedFlow, type ParsedEndpoint } from './flowSchema.js';
import { generateStructured } from './llmClient.js';

export const AmbiguousFieldNoteSchema = z.object({
  endpointId: z.string(),
  fieldName: z.string(),
  note: z.string(),
});
export type AmbiguousFieldNote = z.infer<typeof AmbiguousFieldNoteSchema>;

export const FlowGenerationResultSchema = z.object({
  flow: GeneratedFlowSchema,
  ambiguousFields: z.array(AmbiguousFieldNoteSchema),
});
export type FlowGenerationResult = z.infer<typeof FlowGenerationResultSchema>;

export interface GenerateFlowInput {
  endpoints: ParsedEndpoint[];
  specTitle?: string;
  specDescription?: string;
}

/**
 * LLM call #1: groups the mechanically-parsed endpoints into
 * one flow, orders them, and writes clear title/label/description text.
 * The LLM may only reword and reorder -- it must return exactly the same set
 * of endpoint ids and field names it was given (validateGeneratedFlowIntegrity
 * enforces this the same way the stepEngine's "no invented fields" guardrail
 * does at runtime, since a hallucinated field here would otherwise silently
 * survive until the human review step).
 */
export async function generateFlow(input: GenerateFlowInput): Promise<FlowGenerationResult> {
  const prompt = buildPrompt(input);

  const attempt = async (): Promise<FlowGenerationResult> => {
    const result = await generateStructured(prompt, FlowGenerationResultSchema);
    validateGeneratedFlowIntegrity(result.flow, input.endpoints);
    return result;
  };

  try {
    return await attempt();
  } catch (firstError) {
    try {
      return await attempt();
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`flowGenerator: failed to generate a valid flow after 2 attempts. Last error: ${message}`);
    }
  }
}

function buildPrompt(input: GenerateFlowInput): string {
  const context = [
    input.specTitle ? `Spec title: ${input.specTitle}` : null,
    input.specDescription ? `Spec description: ${input.specDescription}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const endpointCount = input.endpoints.length;
  const endpointIds = input.endpoints.map((e) => e.id).join(', ');

  return `You are helping build a multi-step intake wizard flow from an OpenAPI spec.

Below is a raw, mechanically-extracted list of write-operation endpoints, as JSON. There are exactly ${endpointCount} endpoint(s), with these ids: ${endpointIds}. Each endpoint already has its final set of fields.

Rules:
1. The output "flow.endpoints" array must contain exactly these ${endpointCount} endpoint(s) -- one object per input endpoint, each appearing exactly once. Never split one input endpoint into several output endpoints, never duplicate one, and never add one that wasn't in the input.
2. Keep every endpoint "id" exactly as given -- do not rename, reuse, or repeat an id.
3. Do not add, remove, or rename any field within an endpoint. Keep every field "name", "type", "required", "enumValues", and "validation" exactly as given.
4. You may reorder the endpoints array into the most sensible sequence for a user filling out a multi-step wizard.
5. You may reorder each endpoint's fields array.
6. Write a clear, human-friendly "title" and "description" for the overall flow, and for each endpoint.
7. Rewrite each field's "label" and "description" to be clear, user-facing text.
8. List any field whose purpose or expected value is genuinely ambiguous from the spec alone in "ambiguousFields", with a short "note" explaining why -- do not change the field itself to address the ambiguity, just flag it for human review.

${context ? context + '\n\n' : ''}Raw endpoints (JSON):
${JSON.stringify(input.endpoints, null, 2)}`;
}

function validateGeneratedFlowIntegrity(generated: GeneratedFlow, rawEndpoints: ParsedEndpoint[]): void {
  const rawById = new Map(rawEndpoints.map((endpoint) => [endpoint.id, endpoint]));
  const rawIds = [...rawById.keys()];
  const generatedIds = generated.endpoints.map((endpoint) => endpoint.id);

  if (!sameSet(rawIds, generatedIds)) {
    throw new Error(
      `flowGenerator: generated flow's endpoint ids don't match the input (expected: ${rawIds.join(', ')}; got: ${generatedIds.join(', ')})`
    );
  }

  for (const endpoint of generated.endpoints) {
    const raw = rawById.get(endpoint.id);
    if (!raw) continue; // already reported by the id-set check above

    const rawFieldNames = raw.fields.map((field) => field.name);
    const generatedFieldNames = endpoint.fields.map((field) => field.name);
    if (!sameSet(rawFieldNames, generatedFieldNames)) {
      throw new Error(
        `flowGenerator: endpoint "${endpoint.id}" fields don't match the input (expected: ${rawFieldNames.join(', ')}; got: ${generatedFieldNames.join(', ')})`
      );
    }
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}
