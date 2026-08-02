import { describe, expect, it } from 'vitest';
import { validateEndpointInput } from '../validation.js';
import type { EndpointDef, FieldDef } from '../flowSchema.js';

function makeEndpoint(fields: FieldDef[]): EndpointDef {
  return {
    id: 'test_endpoint',
    description: 'test',
    fields,
    execute: async () => ({ success: true }),
  };
}

describe('validateEndpointInput', () => {
  describe('required fields', () => {
    it('rejects a missing required field', () => {
      const endpoint = makeEndpoint([
        { name: 'name', type: 'string', description: 'name', required: true },
      ]);
      expect(validateEndpointInput(endpoint, {})).toEqual(['"name" is required']);
    });

    it('rejects required field present but empty', () => {
      const endpoint = makeEndpoint([
        { name: 'name', type: 'string', description: 'name', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { name: '' })).toEqual(['"name" is required']);
    });

    it('allows a missing optional field', () => {
      const endpoint = makeEndpoint([
        { name: 'note', type: 'string', description: 'note', required: false },
      ]);
      expect(validateEndpointInput(endpoint, {})).toEqual([]);
    });
  });

  describe('types', () => {
    it('rejects a non-string value for a string field', () => {
      const endpoint = makeEndpoint([
        { name: 'name', type: 'string', description: 'name', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { name: 42 })).toEqual(['"name" must be a string']);
    });

    it('rejects a string for a number field', () => {
      const endpoint = makeEndpoint([
        { name: 'years', type: 'number', description: 'years', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { years: 'three' })).toEqual([
        '"years" must be a number',
      ]);
    });

    it('accepts a valid number', () => {
      const endpoint = makeEndpoint([
        { name: 'years', type: 'number', description: 'years', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { years: 3 })).toEqual([]);
    });

    it('rejects a non-boolean for a boolean field', () => {
      const endpoint = makeEndpoint([
        { name: 'agree', type: 'boolean', description: 'agree', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { agree: 'yes' })).toEqual([
        '"agree" must be a boolean',
      ]);
    });
  });

  describe('date', () => {
    it('accepts an ISO date string', () => {
      const endpoint = makeEndpoint([
        { name: 'start', type: 'date', description: 'start', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { start: '2026-09-01' })).toEqual([]);
    });

    it('rejects an unparseable date', () => {
      const endpoint = makeEndpoint([
        { name: 'start', type: 'date', description: 'start', required: true },
      ]);
      expect(validateEndpointInput(endpoint, { start: 'someday' })).toEqual([
        '"start" must be a valid date',
      ]);
    });
  });

  describe('enum', () => {
    it('accepts a valid enum value', () => {
      const endpoint = makeEndpoint([
        {
          name: 'arrangement',
          type: 'enum',
          description: 'arrangement',
          required: true,
          enumValues: ['remote', 'hybrid', 'onsite'],
        },
      ]);
      expect(validateEndpointInput(endpoint, { arrangement: 'remote' })).toEqual([]);
    });

    it('rejects an invalid enum value', () => {
      const endpoint = makeEndpoint([
        {
          name: 'arrangement',
          type: 'enum',
          description: 'arrangement',
          required: true,
          enumValues: ['remote', 'hybrid', 'onsite'],
        },
      ]);
      expect(validateEndpointInput(endpoint, { arrangement: 'office' })).toEqual([
        '"arrangement" must be one of: remote, hybrid, onsite',
      ]);
    });
  });

  describe('validation rules', () => {
    it('rejects a string that does not match the pattern', () => {
      const endpoint = makeEndpoint([
        {
          name: 'email',
          type: 'string',
          description: 'email',
          required: true,
          validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
        },
      ]);
      expect(validateEndpointInput(endpoint, { email: 'not-an-email' })).toEqual([
        '"email" does not match the required format',
      ]);
    });

    it('accepts a string matching the pattern', () => {
      const endpoint = makeEndpoint([
        {
          name: 'email',
          type: 'string',
          description: 'email',
          required: true,
          validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
        },
      ]);
      expect(validateEndpointInput(endpoint, { email: 'alice@example.com' })).toEqual([]);
    });

    it('enforces min on numbers', () => {
      const endpoint = makeEndpoint([
        {
          name: 'years',
          type: 'number',
          description: 'years',
          required: true,
          validation: { min: 0 },
        },
      ]);
      expect(validateEndpointInput(endpoint, { years: -1 })).toEqual([
        '"years" must be at least 0',
      ]);
    });

    it('enforces max on numbers', () => {
      const endpoint = makeEndpoint([
        {
          name: 'years',
          type: 'number',
          description: 'years',
          required: true,
          validation: { max: 50 },
        },
      ]);
      expect(validateEndpointInput(endpoint, { years: 51 })).toEqual(['"years" must be at most 50']);
    });

    it('enforces min length on strings', () => {
      const endpoint = makeEndpoint([
        {
          name: 'name',
          type: 'string',
          description: 'name',
          required: true,
          validation: { min: 2 },
        },
      ]);
      expect(validateEndpointInput(endpoint, { name: 'A' })).toEqual([
        '"name" must be at least 2 characters',
      ]);
    });

    it('reports multiple errors at once', () => {
      const endpoint = makeEndpoint([
        {
          name: 'email',
          type: 'string',
          description: 'email',
          required: true,
          validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
        },
        { name: 'years', type: 'number', description: 'years', required: true, validation: { min: 0 } },
      ]);
      expect(validateEndpointInput(endpoint, { email: 'nope', years: 'many' })).toEqual([
        '"email" does not match the required format',
        '"years" must be a number',
      ]);
    });
  });
});
