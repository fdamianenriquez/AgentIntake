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

// ---------------------------------------------------------------------------
// Operations contract (README: "React API"). Everything here runs in the browser; the
// server never calls a target API.
// ---------------------------------------------------------------------------

export const OperationFailureSchema = z.object({
  kind: z.enum(['network', 'timeout', 'http', 'other']),
  status: z.number().optional(),
  message: z.string().optional(),
});
export type OperationFailure = z.infer<typeof OperationFailureSchema>;

export interface OperationResult {
  success: boolean;
  message?: string;
  /** Id of the created/updated resource; read/update/undo only work when create returns one. */
  resourceId?: string;
  /** Anything later steps may need, available to them as `ctx.results[endpointId].output`. */
  output?: Record<string, unknown>;
  /** Present iff success === false. */
  failure?: OperationFailure;
}

export interface ExecContext {
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Results of completed steps, keyed by endpoint id (e.g. ids created earlier). */
  results: Record<string, OperationResult>;
  /**
   * Stable across retries of the same logical operation, new once the values
   * change or the operation succeeds. AgentIntake never uses it itself -- send it
   * as an Idempotency-Key header if the target API supports one.
   */
  idempotencyKey: string;
  /** For update(): the step's previously submitted values. */
  previousValues?: Record<string, unknown>;
}

export type ExecuteFn = (data: Record<string, unknown>, context: ExecContext) => Promise<OperationResult>;

export interface ResourceOperations {
  create: ExecuteFn;
  read?: (
    context: ExecContext & { resourceId: string }
  ) => Promise<{ found: true; data: Record<string, unknown> } | { found: false }>;
  update?: (data: Record<string, unknown>, context: ExecContext & { resourceId: string }) => Promise<OperationResult>;
  undo?: (context: ExecContext & { resourceId: string }) => Promise<OperationResult>;
}

export const EndpointCapabilitiesSchema = z.object({
  read: z.boolean(),
  update: z.boolean(),
  undo: z.boolean(),
});
export type EndpointCapabilities = z.infer<typeof EndpointCapabilitiesSchema>;

// Functions are written by the flow author, never produced by an LLM, so they
// are checked as "is callable" rather than parsed like the rest of the schema.
const ExecuteFnSchema = z.custom<ExecuteFn>((val) => typeof val === 'function', {
  error: 'execute must be a function',
});

const isOptionalFn = (val: unknown) => val === undefined || typeof val === 'function';
const ResourceOperationsSchema = z.custom<ResourceOperations>(
  (val) => {
    if (typeof val !== 'object' || val === null) return false;
    const ops = val as Record<string, unknown>;
    return typeof ops.create === 'function' && isOptionalFn(ops.read) && isOptionalFn(ops.update) && isOptionalFn(ops.undo);
  },
  { error: 'operations needs a create function; read, update and undo must be functions when present' }
);

// The data part of an endpoint, without any functions. This is what the parser
// and the generator produce, and what goes over the wire.
const EndpointBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  fields: z.array(FieldDefSchema),
  auth: AuthRequirementSchema.optional(),
  capabilities: EndpointCapabilitiesSchema.optional(),
});
type EndpointBase = z.infer<typeof EndpointBaseSchema>;

export const EndpointDefSchema = EndpointBaseSchema.extend({
  execute: ExecuteFnSchema.optional(),
  operations: ResourceOperationsSchema.optional(),
}).refine((endpoint) => (endpoint.execute === undefined) !== (endpoint.operations === undefined), {
  error: 'An endpoint needs exactly one of `execute` (v1.0 style) or `operations`.',
});

// `execute` is the v1.0 API and is equivalent to `operations: { create }`.
export type EndpointDef = EndpointBase &
  ({ execute: ExecuteFn; operations?: undefined } | { operations: ResourceOperations; execute?: undefined });

export const FlowDefSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  endpoints: z.array(EndpointDefSchema),
});
export interface FlowDef {
  id: string;
  title: string;
  description: string;
  endpoints: EndpointDef[];
}

// An endpoint without functions: shared by openapiParser.ts (mechanical
// extraction never produces them) and flowGenerator.ts (an LLM can't return a
// function either -- operations are wired up by the flow author once the
// generated flow has been reviewed by a person).
export const ParsedEndpointSchema = EndpointBaseSchema;
export type ParsedEndpoint = z.infer<typeof ParsedEndpointSchema>;

// The shape of flowGenerator.ts's LLM structured output: a full flow, but
// with execute-less endpoints (see ParsedEndpointSchema above).
export const GeneratedFlowSchema = FlowDefSchema.extend({
  endpoints: z.array(ParsedEndpointSchema),
});
export type GeneratedFlow = z.infer<typeof GeneratedFlowSchema>;

// The response of flow generation (flowGenerator.ts, /api/generate-flow), shared
// with Studio, which validates what the server returns.
export const AmbiguousFieldNoteSchema = z.object({
  endpointId: z.string(),
  fieldName: z.string(),
  note: z.string(),
});
export type AmbiguousFieldNote = z.infer<typeof AmbiguousFieldNoteSchema>;

export const FlowGenerationResultSchema = z.object({
  flow: GeneratedFlowSchema,
  ambiguousFields: z.array(AmbiguousFieldNoteSchema),
});
export type FlowGenerationResult = z.infer<typeof FlowGenerationResultSchema>;
