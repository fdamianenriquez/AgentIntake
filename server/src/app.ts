import express, { type ErrorRequestHandler, type Express } from 'express';
import cors from 'cors';
import { handleCheckInvalidation } from './routes/checkInvalidation.js';
import { handleClassifyFailure } from './routes/classifyFailure.js';
import { handleGenerateFlow } from './routes/generateFlow.js';
import { handleSessionSync } from './routes/sessionSync.js';
import { handleStepFields } from './routes/stepFields.js';
import { handleStepValidate } from './routes/stepValidate.js';
import { loadConfig, type AgentIntakeConfig } from './config.js';
import { loadTrustedFlows } from './trustedFlows.js';
import { resolveLogLevel } from './logger.js';
import type { GeneratedFlow } from '../../packages/react-agent-intake/src/contracts.js';
import type { ServerContext } from './serverContext.js';

// A real-world spec describes a whole API, even though only its write
// operations are used, so it routinely exceeds express.json()'s 100kb default.
// The per-step routes only ever carry one endpoint and its answers, so they
// keep the default.
export const SPEC_BODY_LIMIT = '10mb';

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

// Without this, body-parser failures fall through to Express's default
// handler, which answers with an HTML page (including a stack trace outside
// production) -- unreadable for API clients like Studio.
const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message =
    error?.type === 'entity.too.large'
      ? `Request body is too large (limit: ${formatBytes(error.limit)}).`
      : error?.type === 'entity.parse.failed'
        ? 'Request body is not valid JSON.'
        : status < 500
          ? String(error?.message ?? 'Bad request.')
          : 'Internal server error.';
  res.status(status).json({ error: message });
};

// AGENTINTAKE_CORS_ORIGINS: comma-separated origins allowed to call the API
// from a browser. Unset, any origin is allowed (so the local demo works out of
// the box) and a warning says so once per process.
function corsOriginsFromEnv(): string[] | null {
  const entries = (process.env.AGENTINTAKE_CORS_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries.map(toOrigin) : null;
}

// A browser's Origin header is scheme://host[:port] with nothing after it, so
// an entry is normalized to exactly that ("https://app.example.com/" matches)
// and anything else -- a path, a query, no scheme -- stops the server at
// startup rather than silently never matching.
function toOrigin(entry: string): string {
  const invalid = () =>
    new Error(
      `AGENTINTAKE_CORS_ORIGINS: "${entry}" is not an origin. Use scheme://host[:port] with no path, e.g. https://app.example.com.`
    );
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw invalid();
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !bare || entry.includes('?') || entry.includes('#')) {
    throw invalid();
  }
  return url.origin;
}

let warnedOpenCors = false;

export interface CreateAppOptions {
  /** Studio turns this off: its own guard already rejects other origins. */
  warnOpenCors?: boolean;
  /** Settings to use instead of loading agentintake.config.json (null: none). */
  config?: AgentIntakeConfig | null;
  /**
   * Read on every request instead of loading the config once: Studio holds
   * the current config and swaps it after a save, with no restart.
   */
  getConfig?: () => AgentIntakeConfig | null;
  /** Trusted flows to use instead of loading AGENTINTAKE_FLOWS_DIR (null: off). */
  trustedFlows?: Map<string, GeneratedFlow> | null;
}

// Separated from index.ts (not part of  sketch, but the standard
// Express split) so tests can build and exercise the app -- routes, CORS,
// JSON parsing -- without binding a real port.
export function createApp({ warnOpenCors = true, config, getConfig, trustedFlows }: CreateAppOptions = {}): Express {
  const app = express();
  // An invalid AGENTINTAKE_LOG_LEVEL stops startup, like an invalid config.
  resolveLogLevel();
  // Loaded once; an invalid file stops startup with the file, place and rule.
  const context: ServerContext = {
    guidance: getConfig ? undefined : (config === undefined ? loadConfig() : config)?.guidance,
    trustedFlows: (trustedFlows === undefined ? loadTrustedFlows() : trustedFlows) ?? undefined,
    unknownFlowIds: { seen: new Set(), full: false },
  };
  const origins = corsOriginsFromEnv();
  if (!origins && warnOpenCors && !warnedOpenCors) {
    warnedOpenCors = true;
    console.warn(
      'AgentIntake: CORS is open to every origin. Set AGENTINTAKE_CORS_ORIGINS to your app\'s origin(s) before exposing this server.'
    );
  }
  app.use(cors(origins ? { origin: origins } : {}));
  app.use((_req, res, next) => {
    res.locals.agentIntake = getConfig ? { ...context, guidance: getConfig()?.guidance } : context;
    next();
  });

  app.post('/api/generate-flow', express.json({ limit: SPEC_BODY_LIMIT }), handleGenerateFlow);
  app.post('/api/step/fields', express.json(), handleStepFields);
  app.post('/api/step/validate', express.json(), handleStepValidate);
  app.post('/api/session/sync', express.json(), handleSessionSync);
  // Carries the definitions of every later step, so it gets more room.
  app.post('/api/step/check-invalidation', express.json({ limit: '1mb' }), handleCheckInvalidation);
  app.post('/api/step/classify-failure', express.json({ limit: '1mb' }), handleClassifyFailure);

  app.use(jsonErrorHandler);
  return app;
}
