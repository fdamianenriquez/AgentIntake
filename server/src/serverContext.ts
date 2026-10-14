import type { Response } from 'express';
import type { GeneratedFlow, WireFlow } from '../../packages/react-agent-intake/src/contracts.js';
import { guidanceFor, type GlobalGuidance, type PromptCall, type PromptGuidance } from './prompts/guidance.js';

// What createApp() loaded at startup and every route may need. Set on
// res.locals per request, so it works the same whether the app runs on its
// own or is mounted inside Studio.
export interface ServerContext {
  /** From agentintake.config.json; undefined when there is no config. */
  guidance?: GlobalGuidance;
  /** From AGENTINTAKE_FLOWS_DIR, keyed by flow id; undefined when trusted flows are off. */
  trustedFlows?: Map<string, GeneratedFlow>;
  /**
   * Unknown flow ids already warned about, so each is reported once, and
   * whether the cap was reached. One object, shared by reference, so it stays
   * one record even when the context is copied per request (Studio).
   */
  unknownFlowIds?: { seen: Set<string>; full: boolean };
}

/**
 * Unknown flow ids come from clients, so the set that remembers them is
 * capped: past this many, one last message is logged and no more are kept --
 * random ids can't grow memory or flood the log.
 */
export const MAX_WARNED_FLOW_IDS = 1000;

export function serverContext(res: Response): ServerContext {
  return (res.locals.agentIntake as ServerContext | undefined) ?? {};
}

/**
 * The guidance for one runtime call. With trusted flows off, the client's
 * flow and step guidance is used. With them on, the client's is never used,
 * whatever the request contains: a flow the server knows gets the server
 * copy's flow and step guidance (and its step titles); an unknown or missing
 * flow id gets the global guidance only, reported once per id -- otherwise
 * changing or leaving out the id would bring the client's guidance back.
 */
export function runtimeGuidance(
  res: Response,
  call: Exclude<PromptCall, 'generation'>,
  wireFlow: WireFlow | undefined,
  steps: { id: string; title: string; guidance?: string }[]
): PromptGuidance | undefined {
  const context = serverContext(res);
  if (!context.trustedFlows) return guidanceFor(call, context.guidance, wireFlow, steps);

  const trusted = wireFlow && context.trustedFlows.get(wireFlow.id);
  if (trusted) {
    const trustedSteps = new Map(trusted.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    return guidanceFor(
      call,
      context.guidance,
      { guidance: trusted.guidance, outputLanguage: trusted.outputLanguage },
      steps.map((step) => {
        const own = trustedSteps.get(step.id);
        return { title: own?.title ?? step.title, guidance: own?.guidance };
      })
    );
  }

  const id = wireFlow?.id ?? '(missing)';
  const unknown = context.unknownFlowIds;
  if (unknown && !unknown.seen.has(id) && !unknown.full) {
    if (unknown.seen.size < MAX_WARNED_FLOW_IDS) {
      unknown.seen.add(id);
      console.warn(
        `AgentIntake: flow ${wireFlow ? `"${id}"` : id} is not in AGENTINTAKE_FLOWS_DIR; the client's flow and step guidance was ignored.`
      );
    } else {
      unknown.full = true;
      console.warn(
        `AgentIntake: ${MAX_WARNED_FLOW_IDS} unknown flow ids reported; further unknown flow ids are not reported (their guidance is still ignored).`
      );
    }
  }
  return guidanceFor(call, context.guidance, undefined, []);
}
