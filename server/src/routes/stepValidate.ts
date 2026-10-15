import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema, WireFlowSchema } from '../../../packages/react-agent-intake/src/contracts.js';
import { validateStepSubmission } from '../stepEngine.js';
import { runtimeGuidance } from '../serverContext.js';
import { getOrCreateSession, getScopedData, recordValidatedStep } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  // The steps before this one, in flow order. When present, only their data
  // reaches the prompt; absent means all collected data.
  precedingEndpointIds: z.array(z.string().max(256)).max(200).optional(),
  endpoint: ParsedEndpointSchema,
  data: z.record(z.string(), z.unknown()),
  // The flow's id and author guidance; absent from older clients.
  flow: WireFlowSchema.optional(),
});

// Note: this route only reports the semantic-validation verdict -- it only
// ever means "this data is trustworthy enough for the AI to use as context
// later", never "the user finished this step." Calling the endpoint's real
// execute() and reaching a true 'complete' StepStatus happens client-side
// (useAgentForm) once it sees `valid: true`
// here -- see the comment on validateStepSubmission in stepEngine.ts, and
// the naming note on sessionStore.ts, for why.
export async function handleStepValidate(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { sessionId: string, endpoint: ParsedEndpoint, data: object }.',
    });
    return;
  }

  const { sessionId, endpoint, data, precedingEndpointIds, flow } = parsed.data;
  const session = getOrCreateSession(sessionId);

  try {
    const previouslyCollectedData = precedingEndpointIds ? getScopedData(sessionId, precedingEndpointIds) : session.collectedData;
    const guidance = runtimeGuidance(res, 'validate', flow, [endpoint]);
    const result = await validateStepSubmission({ endpoint, data, previouslyCollectedData, guidance });
    if (result.valid) {
      recordValidatedStep(sessionId, endpoint.id, data);
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
