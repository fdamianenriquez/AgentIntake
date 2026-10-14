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
  /** Flow ids already warned about, so each unknown id is reported once. */
  warnedFlowIds?: Set<string>;
}

export function serverContext(res: Response): ServerContext {
  return (res.locals.agentIntake as ServerContext | undefined) ?? {};
}

/**
 * The guidance for one runtime call. With trusted flows on and a flow the
 * server knows, the flow's and the steps' guidance come from the server's copy
 * and whatever the client sent is ignored; otherwise the client's is used (an
 * unknown flow id is reported once).
 */
export function runtimeGuidance(
  res: Response,
  call: Exclude<PromptCall, 'generation'>,
  wireFlow: WireFlow | undefined,
  steps: { id: string; title: string; guidance?: string }[]
): PromptGuidance | undefined {
  const context = serverContext(res);
  const trusted = wireFlow && context.trustedFlows?.get(wireFlow.id);

  if (trusted) {
    const trustedSteps = new Map(trusted.endpoints.map((endpoint) => [endpoint.id, endpoint.guidance]));
    return guidanceFor(
      call,
      context.guidance,
      { guidance: trusted.guidance, outputLanguage: trusted.outputLanguage },
      steps.map((step) => ({ title: step.title, guidance: trustedSteps.get(step.id) }))
    );
  }

  if (context.trustedFlows && wireFlow && !context.warnedFlowIds?.has(wireFlow.id)) {
    context.warnedFlowIds?.add(wireFlow.id);
    console.warn(
      `AgentIntake: flow "${wireFlow.id}" is not in AGENTINTAKE_FLOWS_DIR; using the guidance the client sent.`
    );
  }
  return guidanceFor(call, context.guidance, wireFlow, steps);
}
