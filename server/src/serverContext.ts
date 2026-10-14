import type { Response } from 'express';
import type { GlobalGuidance } from './prompts/guidance.js';

// What createApp() loaded at startup and every route may need. Set on
// res.locals per request, so it works the same whether the app runs on its
// own or is mounted inside Studio.
export interface ServerContext {
  /** From agentintake.config.json; undefined when there is no config. */
  guidance?: GlobalGuidance;
}

export function serverContext(res: Response): ServerContext {
  return (res.locals.agentIntake as ServerContext | undefined) ?? {};
}
