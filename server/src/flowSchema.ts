import { z } from 'zod';

export const AuthRequirementSchema = z.object({
  type: z.enum(['apiKey', 'http', 'oauth2', 'openIdConnect', 'none']),
  scheme: z.string().optional(),
  in: z.enum(['header', 'query', 'cookie']).optional(),
  name: z.string().optional(),
});
export type AuthRequirement = z.infer<typeof AuthRequirementSchema>;

export const FieldValidationSchema = z.object({
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const FieldDefSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'enum']),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
  validation: FieldValidationSchema.optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

export interface ExecuteContext {
  getAuthHeaders?: () => Record<string, string>;
}

export type ExecuteResult = { success: boolean; message?: string };

export type ExecuteFn = (
  data: Record<string, unknown>,
  context: ExecuteContext
) => Promise<ExecuteResult>;

// execute() is wired up by the flow author (or the demo/CLI scaffolding), never
// produced by an LLM call, so it's validated as "is this callable" rather than
// deeply parsed like the rest of the schema.
const ExecuteFnSchema = z.custom<ExecuteFn>(
  (val) => typeof val === 'function',
  { error: 'execute must be a function' }
);

export const EndpointDefSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  fields: z.array(FieldDefSchema),
  auth: AuthRequirementSchema.optional(),
  execute: ExecuteFnSchema,
});
export type EndpointDef = z.infer<typeof EndpointDefSchema>;

export const FlowDefSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  endpoints: z.array(EndpointDefSchema),
});
export type FlowDef = z.infer<typeof FlowDefSchema>;
