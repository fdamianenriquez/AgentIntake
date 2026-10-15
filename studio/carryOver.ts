import type { GeneratedFlow } from '../packages/react-agent-intake/src/contracts.js';

// Regenerating a flow in the same Studio session keeps the author's guidance
// like `generate --keep-guidance`: flow-level guidance and
// language, and each step's guidance by endpoint id. Guidance for a step that
// no longer exists is dropped, and reported.
export function carryOverGuidance(previous: GeneratedFlow, next: GeneratedFlow): { flow: GeneratedFlow; droppedSteps: string[] } {
  const ids = new Set(next.endpoints.map((endpoint) => endpoint.id));
  const kept = new Map(previous.endpoints.filter((endpoint) => endpoint.guidance).map((endpoint) => [endpoint.id, endpoint.guidance!]));
  const { endpoints, ...head } = next;
  return {
    flow: {
      ...head,
      ...(previous.guidance !== undefined ? { guidance: previous.guidance } : {}),
      ...(previous.outputLanguage !== undefined ? { outputLanguage: previous.outputLanguage } : {}),
      endpoints: endpoints.map((endpoint) => (kept.has(endpoint.id) ? { ...endpoint, guidance: kept.get(endpoint.id) } : endpoint)),
    },
    droppedSteps: previous.endpoints.filter((endpoint) => endpoint.guidance && !ids.has(endpoint.id)).map((endpoint) => endpoint.title),
  };
}
