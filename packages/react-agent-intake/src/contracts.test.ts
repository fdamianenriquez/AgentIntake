import { describe, expect, it } from 'vitest';
import {
  AuthRequirementSchema,
  EndpointDefSchema,
  FieldDefSchema,
  FlowDefSchema,
  GeneratedFlowSchema,
  GUIDANCE_LIMITS,
} from './contracts.js';
import { exampleFlow } from '../../../server/src/exampleFlow.js';

describe('FlowDefSchema', () => {
  it('accepts the hand-written example flow', () => {
    const result = FlowDefSchema.safeParse(exampleFlow);
    expect(result.success).toBe(true);
  });

  it('accepts a flow with zero endpoints', () => {
    const result = FlowDefSchema.safeParse({
      id: 'empty',
      title: 'Empty flow',
      description: 'No endpoints yet.',
      endpoints: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a flow missing a required top-level field', () => {
    const { endpoints, ...withoutId } = exampleFlow;
    void endpoints;
    const result = FlowDefSchema.safeParse({ ...withoutId, id: undefined });
    expect(result.success).toBe(false);
  });
});

describe('EndpointDefSchema', () => {
  const baseEndpoint = exampleFlow.endpoints[0];

  it('accepts a valid endpoint', () => {
    expect(EndpointDefSchema.safeParse(baseEndpoint).success).toBe(true);
  });

  it('rejects an endpoint whose execute is not a function', () => {
    const result = EndpointDefSchema.safeParse({
      ...baseEndpoint,
      execute: 'not-a-function',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an endpoint with no auth requirement', () => {
    const { auth, ...withoutAuth } = baseEndpoint;
    void auth;
    expect(EndpointDefSchema.safeParse(withoutAuth).success).toBe(true);
  });
});

describe('FieldDefSchema', () => {
  it('accepts a minimal required string field', () => {
    const result = FieldDefSchema.safeParse({
      name: 'age',
      type: 'number',
      label: 'Age',
      required: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a field with an invalid type', () => {
    const result = FieldDefSchema.safeParse({
      name: 'age',
      type: 'integer', // not in the allowed enum
      label: 'Age',
      required: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a field missing the required flag', () => {
    const result = FieldDefSchema.safeParse({
      name: 'age',
      type: 'number',
      label: 'Age',
    });
    expect(result.success).toBe(false);
  });

  it('accepts nested validation constraints', () => {
    const result = FieldDefSchema.safeParse({
      name: 'age',
      type: 'number',
      label: 'Age',
      required: true,
      validation: { min: 18, max: 99 },
    });
    expect(result.success).toBe(true);
  });
});

describe('AuthRequirementSchema', () => {
  it('accepts a valid apiKey auth requirement', () => {
    const result = AuthRequirementSchema.safeParse({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the "none" auth type with no other fields', () => {
    expect(AuthRequirementSchema.safeParse({ type: 'none' }).success).toBe(true);
  });

  it('rejects an invalid auth type', () => {
    const result = AuthRequirementSchema.safeParse({ type: 'basic' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid "in" value', () => {
    const result = AuthRequirementSchema.safeParse({
      type: 'apiKey',
      in: 'body',
      name: 'X-API-Key',
    });
    expect(result.success).toBe(false);
  });
});

describe('EndpointDefSchema: execute XOR operations', () => {
  const base = { id: 'e', title: 'E', fields: [] };
  const fn = async () => ({ success: true });

  it('accepts execute alone', () => {
    expect(EndpointDefSchema.safeParse({ ...base, execute: fn }).success).toBe(true);
  });

  it('accepts operations with create (and optional read/update/undo)', () => {
    expect(EndpointDefSchema.safeParse({ ...base, operations: { create: fn } }).success).toBe(true);
    expect(EndpointDefSchema.safeParse({ ...base, operations: { create: fn, read: fn, update: fn, undo: fn } }).success).toBe(true);
  });

  it('rejects both, and neither', () => {
    expect(EndpointDefSchema.safeParse({ ...base, execute: fn, operations: { create: fn } }).success).toBe(false);
    const neither = EndpointDefSchema.safeParse(base);
    expect(neither.success).toBe(false);
    expect(neither.error?.issues[0]?.message).toMatch(/exactly one of `execute`/);
  });

  it('rejects operations without create, or with a non-function operation', () => {
    expect(EndpointDefSchema.safeParse({ ...base, operations: { read: fn } }).success).toBe(false);
    expect(EndpointDefSchema.safeParse({ ...base, operations: { create: fn, undo: 'DELETE /x' } }).success).toBe(false);
  });
});

describe('flow.json author guidance', () => {
  const flow = {
    id: 'onboarding',
    title: 'Onboarding',
    description: 'd',
    guidance: 'Most sellers are small businesses.',
    outputLanguage: 'es-MX',
    endpoints: [{ id: 'createPayout', title: 'Payout', fields: [], guidance: 'Holder must match the legal name.' }],
  };

  it('accepts flow and step guidance and an output language', () => {
    expect(GeneratedFlowSchema.parse(flow)).toEqual(flow);
  });

  it('still accepts a flow without any of them', () => {
    const { guidance: _g, outputLanguage: _l, ...plain } = flow;
    expect(GeneratedFlowSchema.safeParse({ ...plain, endpoints: [{ id: 'a', title: 'A', fields: [] }] }).success).toBe(true);
  });

  it('rejects over-limit guidance and an invalid language, never truncating', () => {
    const issues = (value: unknown) => GeneratedFlowSchema.safeParse(value).error?.issues.map((issue) => issue.path.join('.'));
    expect(issues({ ...flow, guidance: 'x'.repeat(GUIDANCE_LIMITS.flowGuidance + 1) })).toEqual(['guidance']);
    expect(issues({ ...flow, outputLanguage: 'not a language' })).toEqual(['outputLanguage']);
    expect(issues({ ...flow, endpoints: [{ ...flow.endpoints[0], guidance: 'x'.repeat(GUIDANCE_LIMITS.endpointGuidance + 1) }] })).toEqual([
      'endpoints.0.guidance',
    ]);
  });
});
