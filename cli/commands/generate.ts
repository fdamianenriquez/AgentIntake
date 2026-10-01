import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { largeSpecWarning, parseOpenApiFile } from '../../server/src/openapiParser.js';
import { generateFlow } from '../../server/src/flowGenerator.js';
import { resolveProvider, buildModel } from '../../server/src/llmClient.js';

export interface GenerateOptions {
  spec: string;
  output: string;
  provider?: string;
  model?: string;
}

export async function runGenerate(options: GenerateOptions): Promise<void> {
  // CLI flags are the most explicit signal, so they win over whatever's
  // already in the environment (shell-exported vars, or .env loaded at
  // startup -- see cli/index.ts) for this invocation only.
  if (options.provider) process.env.LLM_PROVIDER = options.provider;
  if (options.model) process.env.LLM_MODEL = options.model;

  // Fail fast on a bad LLM_PROVIDER or a missing API key
  // before spending any time parsing the spec.
  const provider = resolveProvider();
  buildModel(provider);

  const endpoints = await parseOpenApiFile(options.spec);

  if (endpoints.length === 0) {
    throw new Error(`No write operations (POST/PUT/PATCH) found in "${options.spec}".`);
  }

  const warning = largeSpecWarning(endpoints.length);
  if (warning) console.warn(`Warning: ${warning}`);

  const { flow, ambiguousFields } = await generateFlow({ endpoints });

  await writeFile(options.output, JSON.stringify(flow, null, 2) + '\n', 'utf-8');

  console.log(`Wrote ${flow.endpoints.length} endpoint(s) to ${path.resolve(options.output)}`);
  console.log(
    'Review the generated flow, then add each endpoint\'s "execute" function by hand -- ' +
      'AgentIntake never generates that part.'
  );

  if (ambiguousFields.length > 0) {
    console.warn(`\n${ambiguousFields.length} field(s) flagged for review:`);
    for (const note of ambiguousFields) {
      console.warn(`  - ${note.endpointId}.${note.fieldName}: ${note.note}`);
    }
  }
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description('Generate a FlowDef from an OpenAPI spec')
    .requiredOption('--spec <path>', 'Path or URL to an OpenAPI 3.x spec (YAML or JSON)')
    .option('--output <path>', 'Output path for the generated flow JSON', 'flow.json')
    .option('--provider <provider>', 'LLM provider to use (overrides LLM_PROVIDER)')
    .option('--model <model>', 'LLM model to use (overrides LLM_MODEL)')
    .action(async (opts: GenerateOptions) => {
      await runGenerate(opts);
    });
}
