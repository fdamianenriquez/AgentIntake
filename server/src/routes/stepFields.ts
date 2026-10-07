import type { Request, Response } from 'express';
import { z } from 'zod';
import { ParsedEndpointSchema } from '../../../packages/react-agent-intake/src/contracts.js';
import { selectStepFields } from '../stepEngine.js';
import { getOrCreateSession, getScopedData } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  // The steps before this one, in flow order. When present, only their data
  // reaches the prompt; absent means all collected data.
  precedingEndpointIds: z.array(z.string().max(256)).max(200).optional(),
  endpoint: ParsedEndpointSchema,
});

export async function handleStepFields(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Request body must be { sessionId: string, endpoint: ParsedEndpoint }.' });
    return;
  }

  const { sessionId, endpoint, precedingEndpointIds } = parsed.data;
  const session = getOrCreateSession(sessionId);

  try {
    const previouslyCollectedData = precedingEndpointIds
      ? getScopedData(sessionId, precedingEndpointIds)
      : session.collectedData;
    const result = await selectStepFields({ endpoint, previouslyCollectedData });
    res.status(200).json(result);
  } catch (error) {
    // selectStepFields already degrades gracefully on its own;
    // reaching here means something genuinely unexpected broke.
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
