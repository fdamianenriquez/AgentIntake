import express, { type ErrorRequestHandler, type Express } from 'express';
import cors from 'cors';
import { handleGenerateFlow } from './routes/generateFlow.js';
import { handleStepFields } from './routes/stepFields.js';
import { handleStepValidate } from './routes/stepValidate.js';

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

// Separated from index.ts (not part of  sketch, but the standard
// Express split) so tests can build and exercise the app -- routes, CORS,
// JSON parsing -- without binding a real port.
export function createApp(): Express {
  const app = express();
  app.use(cors());

  app.post('/api/generate-flow', express.json({ limit: SPEC_BODY_LIMIT }), handleGenerateFlow);
  app.post('/api/step/fields', express.json(), handleStepFields);
  app.post('/api/step/validate', express.json(), handleStepValidate);

  app.use(jsonErrorHandler);
  return app;
}
