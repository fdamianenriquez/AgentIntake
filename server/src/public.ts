// The `agent-intake/server` entry point: the runtime routes as an Express app,
// for mounting behind your own authentication, rate limiting and CORS policy.
// Provider settings come from the environment (LLM_PROVIDER, LLM_MODEL,
// LLM_API_KEY); unlike `npm start`, importing this module reads no .env file.
export { createApp, type CreateAppOptions } from './app.js';
export type { AgentIntakeConfig } from './config.js';
export type { GeneratedFlow } from '../../packages/react-agent-intake/src/contracts.js';
