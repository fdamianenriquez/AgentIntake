import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GUIDANCE_LIMITS, LanguageTagSchema } from '../../packages/react-agent-intake/src/contracts.js';

// agentintake.config.json (README: "Author guidance"): settings that apply to every flow.
// JSON only -- no code runs to load it. Read once at startup by the runtime
// server, the CLI and Studio; a change needs a restart.

export const CONFIG_FILE_NAME = 'agentintake.config.json';

const RuleListSchema = z.array(z.string().max(GUIDANCE_LIMITS.extraRule)).max(GUIDANCE_LIMITS.extraRules);

export const AgentIntakeConfigSchema = z
  .object({
    $schema: z.string().describe('Editor hint pointing at this JSON Schema. Ignored at runtime.').optional(),
    guidance: z
      .object({
        domainContext: z
          .string()
          .max(GUIDANCE_LIMITS.domainContext)
          .describe('What the business or process is, e.g. "B2B payment onboarding for marketplaces".')
          .optional(),
        tone: z
          .string()
          .max(GUIDANCE_LIMITS.tone)
          .describe('Voice of the text the model writes, e.g. "formal, second person".')
          .optional(),
        outputLanguage: LanguageTagSchema.describe(
          'BCP-47 language tag for every user-facing string the model writes. A flow can override it.'
        ).optional(),
        extraRules: z
          .object({
            generation: RuleListSchema.optional(),
            selectFields: RuleListSchema.optional(),
            validate: RuleListSchema.optional(),
            invalidation: RuleListSchema.optional(),
            classifyFailure: RuleListSchema.optional(),
          })
          .strict()
          .describe('Additional rules for one LLM call, at most 10 of up to 300 characters each.')
          .optional(),
      })
      .strict()
      .describe('Author guidance added to what the model is told, for every flow.')
      .optional(),
  })
  // Unknown keys are errors: a misspelled slot would otherwise be ignored
  // without a word.
  .strict();
export type AgentIntakeConfig = z.infer<typeof AgentIntakeConfigSchema>;

/** The JSON Schema published for editors (schemas/agentintake.config.schema.json). */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentIntakeConfigSchema, { io: 'input' }) as Record<string, unknown>;
}

/** Where the config file is (whether or not it exists): AGENTINTAKE_CONFIG, or the default name, from `cwd`. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return path.resolve(cwd, env.AGENTINTAKE_CONFIG?.trim() || CONFIG_FILE_NAME);
}

/**
 * Loads the config file: AGENTINTAKE_CONFIG if set (relative to `cwd`),
 * otherwise agentintake.config.json in `cwd`. A missing default file means no
 * guidance; a missing AGENTINTAKE_CONFIG file, unreadable JSON or a value that
 * breaks the schema is an error naming the file, the place and the rule.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AgentIntakeConfig | null {
  const explicit = env.AGENTINTAKE_CONFIG?.trim();
  const file = resolveConfigPath(env, cwd);
  if (!existsSync(file)) {
    if (explicit) throw new Error(`AGENTINTAKE_CONFIG: ${file} does not exist.`);
    return null;
  }

  return readConfigFile(file);
}

/** Reads and validates one config file; errors name the file, the place and the rule. */
export function readConfigFile(file: string): AgentIntakeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }

  const parsed = AgentIntakeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(top level)';
      return `  ${where}: ${issue.message}`;
    });
    throw new Error(`${file} is invalid:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
