// Prompt for semantic validation (LLM #3). Pure: no I/O, no
// environment, no LLM client.
import type { ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';
import { renderGuidance, type PromptGuidance } from './guidance.js';

// Bump whenever this module's prompt text changes, so a change in what the
// model sees is deliberate and traceable (the snapshot test catches it).
export const PROMPT_VERSION = 2;

export interface ValidatePromptInput {
  endpoint: Pick<ParsedEndpoint, 'id' | 'title' | 'fields'>;
  data: Record<string, unknown>;
  previouslyCollectedData: Record<string, Record<string, unknown>>;
}

export function build(input: ValidatePromptInput, guidance?: PromptGuidance): string {
  const { endpoint, data, previouslyCollectedData } = input;
  return `You are validating one step's submitted data in a multi-step intake wizard, beyond basic client-side checks (format/range) that already passed before this was submitted.

${renderGuidance(guidance)}Step: "${endpoint.title}" (${endpoint.id})

Fields (JSON):
${JSON.stringify(endpoint.fields, null, 2)}

Submitted data (JSON):
${JSON.stringify(data, null, 2)}

Data already collected in earlier steps (JSON):
${JSON.stringify(previouslyCollectedData, null, 2)}

Task: look for implausible values or inconsistencies a simple regex/range check can't catch (e.g. a start date far in the past for a new hire, a value inconsistent with an earlier answer). Only flag genuine problems -- do not invent stricter rules than the field descriptions and the author's guidance imply.

Return "valid: true" with an empty "errors" array if nothing looks wrong. Otherwise return "valid: false" and one entry per problem in "errors", each with the exact field "name" (from the fields list above) and a short, user-facing "message".`;
}
