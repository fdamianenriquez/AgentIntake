import type { Request, Response } from 'express';
import { z } from 'zod';
import { replaceStepData } from '../sessionStore.js';

const RequestBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  steps: z
    .array(
      z.object({
        endpointId: z.string().min(1).max(256),
        // The step's data as the client now has it, or null to forget the step.
        data: z.record(z.string(), z.unknown()).nullable(),
      })
    )
    .min(1)
    .max(200),
});

// Lets the client bring the server session back in line with
// what was actually submitted -- e.g. after an edit is cancelled, since
// /api/step/validate already recorded the edited values.
export function handleSessionSync(req: Request, res: Response): void {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { sessionId: string, steps: { endpointId: string, data: object | null }[] }.',
    });
    return;
  }

  replaceStepData(parsed.data.sessionId, parsed.data.steps);
  res.status(200).json({ ok: true });
}
