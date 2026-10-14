// Prompt for cross-step invalidation (LLM #5). Pure: no I/O,
// no environment, no LLM client.
import type { ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';
import { REASON_TARGET_LENGTH } from './limits.js';
import { renderGuidance, type PromptGuidance } from './guidance.js';

// Bump whenever this module's prompt text changes, so a change in what the
// model sees is deliberate and traceable (the snapshot test catches it).
export const PROMPT_VERSION = 1;

type StepSummary = Pick<ParsedEndpoint, 'id' | 'title' | 'description' | 'fields'>;

export interface InvalidationPromptInput {
  editedEndpoint: StepSummary;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  laterCompletedEndpoints: StepSummary[];
  laterData?: Record<string, Record<string, unknown>>;
}

export function build(input: InvalidationPromptInput, guidance?: PromptGuidance): string {
  const laterSteps = input.laterCompletedEndpoints.map((endpoint) => ({
    id: endpoint.id,
    title: endpoint.title,
    description: endpoint.description,
    fields: endpoint.fields.map((field) => ({ name: field.name, label: field.label, description: field.description })),
    submittedData: input.laterData?.[endpoint.id] ?? {},
  }));

  return `In a multi-step intake wizard, the user went back and changed a step they had already completed. Decide which of the LATER completed steps may no longer be correct because of that change.

${renderGuidance(guidance)}Edited step: "${input.editedEndpoint.title}" (${input.editedEndpoint.id})
${input.editedEndpoint.description ? `Description: ${input.editedEndpoint.description}\n` : ''}
Values before the edit (JSON):
${JSON.stringify(input.before, null, 2)}

Values after the edit (JSON):
${JSON.stringify(input.after, null, 2)}

Later completed steps, with what was submitted for each (JSON):
${JSON.stringify(laterSteps, null, 2)}

Task: list in "affected" only the later steps whose submitted data, or whose set of relevant fields, plausibly depends on what changed (for example a name that must match, or fields that only apply to one account type). For each, give its exact "id" as "endpointId" and a short, user-facing "reason": one sentence, under ${REASON_TARGET_LENGTH} characters. Return an empty list if the change doesn't affect any later step.`;
}
