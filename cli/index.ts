#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { resolveLogLevel } from '../server/src/logger.js';
import { registerEvalPromptsCommand } from './commands/evalPrompts.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerStudioCommand } from './commands/studio.js';

// .env at the project root (wherever the CLI is invoked from) is the single
// source of truth for provider settings. Already-set environment variables (e.g.
// injected CI secrets) are left untouched -- loadEnvFile never overwrites an
// existing process.env value, so shell-exported vars naturally win over it.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// An invalid AGENTINTAKE_LOG_LEVEL stops every command before it starts.
try {
  resolveLogLevel();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const program = new Command();

program.name('agent-intake').description('Turns an OpenAPI spec into a single, AI-orchestrated, multi-step form wizard.').version('1.6.0');

registerGenerateCommand(program);
registerStudioCommand(program);
registerEvalPromptsCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
