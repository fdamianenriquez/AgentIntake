// A minimal leveled logger (README: "Logging"), so operators can turn on per-call
// debug lines without a logging dependency. AGENTINTAKE_LOG_LEVEL: error,
// warn (default), info or debug. An invalid value is a startup error.

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.AGENTINTAKE_LOG_LEVEL?.trim();
  if (!raw) return 'warn';
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`AGENTINTAKE_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${raw}").`);
  }
  return raw as LogLevel;
}

// Read at each call (cheap), so a level set before startup -- or in a test --
// always applies. Startup has already rejected an invalid value.
function enabled(level: LogLevel): boolean {
  let current: LogLevel;
  try {
    current = resolveLogLevel();
  } catch {
    current = 'warn';
  }
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(current);
}

export const logger = {
  error: (message: string) => enabled('error') && console.error(message),
  warn: (message: string) => enabled('warn') && console.warn(message),
  info: (message: string) => enabled('info') && console.info(message),
  debug: (message: string) => enabled('debug') && console.debug(message),
};
