import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema } from '../flowSchema.js';
import { validateStepSubmission } from '../stepEngine.js';
import { getOrCreateSession, recordStepCompletion } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1),
  endpoint: ParsedEndpointSchema,
  data: z.record(z.string(), z.unknown()),
});

// Note: this route only reports the semantic-validation verdict. Calling the
// endpoint's real execute() and marking the step complete happens
// client-side once it sees `valid: true` here --
// see the comment on validateStepSubmission in stepEngine.ts for why.
export async function handleStepValidate(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { sessionId: string, endpoint: ParsedEndpoint, data: object }.',
    });
    return;
  }

  const { sessionId, endpoint, data } = parsed.data;
  const session = getOrCreateSession(sessionId);

  try {
    const result = await validateStepSubmission({ endpoint, data, previouslyCollectedData: session.collectedData });
    if (result.valid) {
      recordStepCompletion(sessionId, endpoint.id, data);
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
