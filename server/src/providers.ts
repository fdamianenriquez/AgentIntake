// Provider names and the key variable, with no SDK imports, so browser code
// (Studio's setup screen) can use them without pulling provider SDKs into its
// bundle. llmClient.ts is the only module that imports the SDKs themselves.
export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export type LlmProvider = (typeof SUPPORTED_PROVIDERS)[number];

// One variable for every provider: LLM_API_KEY is the key for whichever
// LLM_PROVIDER is selected. Exported so Studio's setup screen shares
// this single source of truth instead of a second hardcoded name.
export const API_KEY_ENV_VAR = 'LLM_API_KEY';
