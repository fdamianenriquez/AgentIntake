#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { registerGenerateCommand } from './commands/generate.js';

// .env at the project root (wherever the CLI is invoked from) is the single
// source of truth for provider settings. Already-set environment variables (e.g.
// injected CI secrets) are left untouched -- loadEnvFile never overwrites an
// existing process.env value, so shell-exported vars naturally win over it.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const program = new Command();

program
  .name('agent-intake')
  .description('Turns an OpenAPI spec into a single, AI-orchestrated, multi-step form wizard.')
  .version('0.1.0');

registerGenerateCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
