import { Router } from 'express';
import type { Orchestrator } from '../orchestrator.js';
import type { FlowDef } from '../flowSchema.js';

export function createConversationRouter(
  orchestrator: Orchestrator,
  flows: Record<string, FlowDef>,
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/flows', (_req, res) => {
    res.json(
      Object.values(flows).map((flow) => ({
        id: flow.id,
        title: flow.title,
        description: flow.description,
        endpoints: flow.endpoints.map((endpoint) => ({
          id: endpoint.id,
          description: endpoint.description,
        })),
      })),
    );
  });

  router.post('/conversation', async (req, res) => {
    const { sessionId, flowId, message } = req.body ?? {};

    if (
      typeof sessionId !== 'string' ||
      typeof flowId !== 'string' ||
      typeof message !== 'string' ||
      message.trim() === ''
    ) {
      res.status(400).json({ error: 'sessionId, flowId, and a non-empty message are required.' });
      return;
    }

    const flow = flows[flowId];
    if (!flow) {
      res.status(404).json({ error: `Unknown flow: ${flowId}` });
      return;
    }

    try {
      const result = await orchestrator.handleTurn(sessionId, flow, message);
      res.json(result);
    } catch (err) {
      console.error('Error handling turn:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    }
  });

  return router;
}
