// Prompt for flow generation (LLM #1): the parsed endpoints in, a flow
// with clearer text out. Pure: no I/O, no environment, no LLM client.
import type { ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';

// Bump whenever this module's prompt text changes, so a change in what the
// model sees is deliberate and traceable (the snapshot test catches it).
export const PROMPT_VERSION = 1;

export interface GenerationPromptInput {
  endpoints: ParsedEndpoint[];
  specTitle?: string;
  specDescription?: string;
}

export function build(input: GenerationPromptInput): string {
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
1. The output "flow.endpoints" array must contain exactly these ${endpointCount} endpoint(s) -- one object per input endpoint, each appearing exactly once, identified by its exact "id". Never split, duplicate, merge, or add an endpoint.
2. For each endpoint, "fields" must reference exactly that endpoint's own field names below (in any order you like) -- one entry per field, never a name from a different endpoint, never an invented one, never a missing one.
3. You may reorder the endpoints array into the most sensible sequence for a user filling out a multi-step wizard.
4. Write a clear, human-friendly "title" and "description" for the overall flow, and for each endpoint.
5. For each field, optionally set "labelOverride" and/or "descriptionOverride" to rewrite its label/description into clear, user-facing text -- this is most of the value you add, so do it for every field where the raw text could be clearer. Set either to null to keep the field's original label/description. (Field "type", "required", "enumValues", and "validation" aren't part of this output -- they're taken directly from the raw data below, so don't repeat them.)
6. List any field whose purpose or expected value is genuinely ambiguous from the spec alone in "ambiguousFields", with a short "note" explaining why -- do not change the field itself to address the ambiguity, just flag it for human review.

${context ? context + '\n\n' : ''}Raw endpoints (JSON):
${JSON.stringify(input.endpoints, null, 2)}`;
}
