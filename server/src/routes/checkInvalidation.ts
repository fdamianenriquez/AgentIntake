import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema, WireFlowSchema } from '../../../packages/react-agent-intake/src/contracts.js';
import { checkInvalidation } from '../stepEngine.js';
import { runtimeGuidance } from '../serverContext.js';
import { getScopedData } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  editedEndpoint: ParsedEndpointSchema,
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  // Wire endpoints, not just ids: the server holds no flow
  // definitions, and the model needs titles and fields to judge dependence.
  laterCompletedEndpoints: z.array(ParsedEndpointSchema).max(200),
  // The flow's id and author guidance; absent from older clients.
  flow: WireFlowSchema.optional(),
});

export async function handleCheckInvalidation(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { sessionId, editedEndpoint, before: object, after: object, laterCompletedEndpoints: endpoint[] }.',
    });
    return;
  }

  const { sessionId, editedEndpoint, before, after, laterCompletedEndpoints, flow } = parsed.data;
  try {
    const laterData = getScopedData(
      sessionId,
      laterCompletedEndpoints.map((endpoint) => endpoint.id)
    );
    const guidance = runtimeGuidance(res, 'invalidation', flow, [editedEndpoint, ...laterCompletedEndpoints]);
    const result = await checkInvalidation({ editedEndpoint, before, after, laterCompletedEndpoints, laterData, guidance });
    res.status(200).json(result);
  } catch (error) {
    // checkInvalidation already degrades on its own; reaching here means
    // something genuinely unexpected broke.
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
