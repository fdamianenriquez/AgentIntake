import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema, WireFlowSchema } from '../../../packages/react-agent-intake/src/contracts.js';
import { classifyFailure } from '../stepEngine.js';
import { guidanceFor } from '../prompts/guidance.js';
import { serverContext } from '../serverContext.js';
import { getScopedData } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  failedEndpoint: ParsedEndpointSchema,
  failure: z.object({
    kind: z.enum(['network', 'timeout', 'http', 'other']),
    status: z.number().int().optional(),
    message: z.string().max(10_000).optional(),
  }),
  // Wire endpoints in flow order, not just ids: the model needs to know what
  // each completed step is to decide where an undo should start.
  completedEndpoints: z.array(ParsedEndpointSchema).max(200),
  // The flow's id and author guidance; absent from older clients.
  flow: WireFlowSchema.optional(),
});

export async function handleClassifyFailure(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { sessionId, failedEndpoint, failure: { kind, status?, message? }, completedEndpoints: endpoint[] }.',
    });
    return;
  }

  const { sessionId, failedEndpoint, failure, completedEndpoints, flow } = parsed.data;
  try {
    // The failed step passed semantic validation before its operation ran, so
    // the session already holds its data.
    const ids = [...completedEndpoints.map((endpoint) => endpoint.id), failedEndpoint.id];
    const stepData = getScopedData(sessionId, ids);
    const guidance = guidanceFor('classifyFailure', serverContext(res).guidance, flow, [failedEndpoint]);
    res.status(200).json(await classifyFailure({ failedEndpoint, failure, completedEndpoints, stepData, guidance }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
