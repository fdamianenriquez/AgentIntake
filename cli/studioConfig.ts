import { loadConfig, resolveConfigPath, type AgentIntakeConfig } from '../server/src/config.js';

// Studio's copy of agentintake.config.json. The runtime server loads the
// config once at startup; Studio instead reads it from here on every request
// (createApp's getConfig), so a config saved from the Instructions tab
// applies at once, without a restart.
export interface StudioConfigStore {
  /** The resolved config file: AGENTINTAKE_CONFIG or agentintake.config.json, from the working directory. */
  readonly path: string;
  get(): AgentIntakeConfig | null;
  set(config: AgentIntakeConfig | null): void;
}

export function createStudioConfigStore(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): StudioConfigStore {
  const path = resolveConfigPath(env, cwd);
  let current = loadConfig(env, cwd);
  return {
    path,
    get: () => current,
    set: (config) => {
      current = config;
    },
  };
}
