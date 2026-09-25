import express, { type Express } from 'express';
import cors from 'cors';
import { handleGenerateFlow } from './routes/generateFlow.js';
import { handleStepFields } from './routes/stepFields.js';
import { handleStepValidate } from './routes/stepValidate.js';

// Separated from index.ts (not part of  sketch, but the standard
// Express split) so tests can build and exercise the app -- routes, CORS,
// JSON parsing -- without binding a real port.
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post('/api/generate-flow', handleGenerateFlow);
  app.post('/api/step/fields', handleStepFields);
  app.post('/api/step/validate', handleStepValidate);

  return app;
}
