import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema } from '../../../packages/react-agent-intake/src/contracts.js';
import { selectStepFields } from '../stepEngine.js';
import { getOrCreateSession } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  endpoint: ParsedEndpointSchema,
});

export async function handleStepFields(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Request body must be { sessionId: string, endpoint: ParsedEndpoint }.' });
    return;
  }

  const { sessionId, endpoint } = parsed.data;
  const session = getOrCreateSession(sessionId);

  try {
    const result = await selectStepFields({ endpoint, previouslyCollectedData: session.collectedData });
    res.status(200).json(result);
  } catch (error) {
    // selectStepFields already degrades gracefully on its own;
    // reaching here means something genuinely unexpected broke.
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
