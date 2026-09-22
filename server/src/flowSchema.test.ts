import { describe, expect, it } from 'vitest';
import {
  AuthRequirementSchema,
  EndpointDefSchema,
  FieldDefSchema,
  FlowDefSchema,
} from './flowSchema.js';
import { exampleFlow } from './exampleFlow.js';

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
