// Prompt for adaptive field selection (LLM #2). Pure: no I/O,
// no environment, no LLM client.
import type { FieldDef, ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';

// Bump whenever this module's prompt text changes, so a change in what the
// model sees is deliberate and traceable (the snapshot test catches it).
export const PROMPT_VERSION = 1;

export interface SelectFieldsPromptInput {
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'description'>;
  baseFields: FieldDef[];
  previouslyCollectedData: Record<string, Record<string, unknown>>;
}

export function build(input: SelectFieldsPromptInput): string {
  const { endpoint, baseFields, previouslyCollectedData } = input;
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
3. Optionally set "descriptionOverride" on a field to add helpful context based on earlier answers (e.g. referencing what was already collected). Set it to null to keep the field's original description.
4. Optionally suggest confident pre-fill values in "suggestedValues", as one { "name", "value" } entry per field, only for fields you included in "fields" and only when already-collected data makes the value obvious. Leave the list empty otherwise.`;
}
