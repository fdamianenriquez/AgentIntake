import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { parseOpenApiFile } from '../../server/src/openapiParser.js';
import { generateFlow } from '../../server/src/flowGenerator.js';
import { resolveProvider, buildModel } from '../../server/src/llmClient.js';
import { z } from 'zod';
import {
  GeneratedFlowSchema,
  GUIDANCE_LIMITS,
  LanguageTagSchema,
  type GeneratedFlow,
} from '../../packages/react-agent-intake/src/contracts.js';
import { loadConfig } from '../../server/src/config.js';
import { guidanceFor } from '../../server/src/prompts/guidance.js';

export interface GenerateOptions {
  spec: string;
  output: string;
  provider?: string;
  model?: string;
  /** Carry the existing flow.json's author guidance over to the new one. */
  keepGuidance?: boolean;
  /** Overwrite an existing flow.json even if it has author guidance. */
  force?: boolean;
}

interface AuthorGuidance {
  flow: { guidance?: string; outputLanguage?: string };
  endpoints: Map<string, string>;
}

// The author-owned parts of an existing flow.json, or null
// when there is no file, it isn't JSON, or it has none.
async function existingGuidance(file: string): Promise<AuthorGuidance | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const flow = raw as { guidance?: unknown; outputLanguage?: unknown; endpoints?: unknown };
  const endpoints = new Map<string, string>();
  for (const endpoint of Array.isArray(flow.endpoints) ? flow.endpoints : []) {
    if (typeof endpoint?.id === 'string' && typeof endpoint.guidance === 'string') endpoints.set(endpoint.id, endpoint.guidance);
  }
  const found: AuthorGuidance = {
    flow: {
      ...(typeof flow.guidance === 'string' ? { guidance: flow.guidance } : {}),
      ...(typeof flow.outputLanguage === 'string' ? { outputLanguage: flow.outputLanguage } : {}),
    },
    endpoints,
  };
  return Object.keys(found.flow).length > 0 || endpoints.size > 0 ? found : null;
}

// The same limits and language check as any flow.json, applied to what would
// be carried over -- before the spec is parsed or the model is called, so an
// already-invalid file doesn't cost a generation first.
function checkKeptGuidance(file: string, kept: AuthorGuidance): void {
  const problems: string[] = [];
  const check = (where: string, schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) problems.push(`  ${where}: ${result.error.issues[0].message}`);
  };
  if (kept.flow.guidance !== undefined) check('guidance', z.string().max(GUIDANCE_LIMITS.flowGuidance), kept.flow.guidance);
  if (kept.flow.outputLanguage !== undefined) check('outputLanguage', LanguageTagSchema, kept.flow.outputLanguage);
  for (const [id, guidance] of kept.endpoints) {
    check(`endpoints[${id}].guidance`, z.string().max(GUIDANCE_LIMITS.endpointGuidance), guidance);
  }
  if (problems.length > 0) throw new Error(`${file}: the guidance to keep is invalid:\n${problems.join('\n')}`);
}

function withGuidance(flow: GeneratedFlow, kept: AuthorGuidance): { flow: GeneratedFlow; dropped: string[] } {
  const ids = new Set(flow.endpoints.map((endpoint) => endpoint.id));
  const { endpoints, ...head } = flow;
  const merged = {
    ...head,
    ...kept.flow,
    endpoints: endpoints.map((endpoint) =>
      kept.endpoints.has(endpoint.id) ? { ...endpoint, guidance: kept.endpoints.get(endpoint.id) } : endpoint
    ),
  };
  return {
    // Checked like any flow.json: guidance carried over must still be valid.
    flow: GeneratedFlowSchema.parse(merged),
    dropped: [...kept.endpoints.keys()].filter((id) => !ids.has(id)),
  };
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
  // Same for an invalid agentintake.config.json.
  const config = loadConfig();

  // An author's guidance in the existing flow.json is never lost by accident.
  if (options.keepGuidance && options.force) {
    throw new Error('Pass either --keep-guidance or --force, not both.');
  }
  const kept = await existingGuidance(options.output);
  if (kept && !options.keepGuidance && !options.force) {
    throw new Error(
      `${options.output} has author guidance (guidance/outputLanguage) that a new flow would lose. ` +
        'Use --keep-guidance to carry it over by endpoint id, or --force to overwrite it.'
    );
  }
  if (kept && options.keepGuidance) checkKeptGuidance(options.output, kept);

  const { endpoints, warnings } = await parseOpenApiFile(options.spec);

  if (endpoints.length === 0) {
    throw new Error(`No write operations (POST/PUT/PATCH) found in "${options.spec}".`);
  }

  for (const warning of warnings) console.warn(`Warning: ${warning}`);

  const generated = await generateFlow({ endpoints, guidance: guidanceFor('generation', config?.guidance, undefined) });
  const { ambiguousFields } = generated;
  let flow = generated.flow;
  if (kept && options.keepGuidance) {
    const merged = withGuidance(flow, kept);
    flow = merged.flow;
    if (merged.dropped.length > 0) {
      console.warn(`Guidance dropped for endpoint(s) no longer in the spec: ${merged.dropped.join(', ')}`);
    }
  }

  await writeFile(options.output, JSON.stringify(flow, null, 2) + '\n', 'utf-8');

  console.log(`Wrote ${flow.endpoints.length} endpoint(s) to ${path.resolve(options.output)}`);
  console.log(
    'Review the generated flow, then give each endpoint an "execute" function, or "operations" ' +
      '(create, plus read/update/undo where the API offers them) -- AgentIntake never generates that part.'
  );

  const hints = flow.endpoints.flatMap((endpoint) => {
    const lines: string[] = [];
    if (endpoint.capabilities) {
      const offered = (['read', 'update', 'undo'] as const).filter((op) => endpoint.capabilities![op]);
      lines.push(`  - ${endpoint.id}: the API also offers ${offered.join(', ')} on ${endpoint.resourcePath}/{${endpoint.idParam}}`);
    }
    if (endpoint.pathParams?.length) {
      lines.push(`  - ${endpoint.id}: fill path parameter(s) ${endpoint.pathParams.join(', ')} from ctx.results`);
    }
    return lines;
  });
  if (hints.length > 0) {
    console.log('\nWhat the spec says each endpoint needs:');
    for (const line of hints) console.log(line);
  }

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
    .option('--keep-guidance', "Carry the existing output file's author guidance over, by endpoint id")
    .option('--force', 'Overwrite an existing output file even if it has author guidance')
    .action(async (opts: GenerateOptions) => {
      await runGenerate(opts);
    });
}
