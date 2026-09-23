import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import { parseOpenApiDocument, parseOpenApiFile, ParsedEndpointSchema } from './openapiParser.js';

function baseDoc(paths: OpenAPIV3.PathsObject, extra: Partial<OpenAPIV3.Document> = {}): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Fixture API', version: '1.0.0' },
    paths,
    ...extra,
  };
}

describe('parseOpenApiDocument', () => {
  it('rejects a non-3.x document', () => {
    const doc = { ...baseDoc({}), openapi: '2.0' };
    expect(() => parseOpenApiDocument(doc)).toThrow(/OpenAPI 3\.x/);
  });

  it('only extracts write operations (post/put/patch), ignoring get/delete', () => {
    const doc = baseDoc({
      '/widgets': {
        get: { responses: {} },
        delete: { responses: {} },
        post: {
          operationId: 'createWidget',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const endpoints = parseOpenApiDocument(doc);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe('createWidget');
  });

  it('derives an id and title from method+path when operationId is missing', () => {
    const doc = baseDoc({
      '/candidates/{id}/notes': {
        put: { responses: {} },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    expect(endpoint.id).toBe('put-candidates-id-notes');
    expect(endpoint.title).toBe('PUT /candidates/{id}/notes');
  });

  it('maps simple scalar types with validation constraints', () => {
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'yearsOfExperience'],
                  properties: {
                    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
                    yearsOfExperience: { type: 'integer', minimum: 0, maximum: 50 },
                    isRemote: { type: 'boolean' },
                    startDate: { type: 'string', format: 'date' },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    const byName = Object.fromEntries(endpoint.fields.map((f) => [f.name, f]));

    expect(byName.email).toMatchObject({
      type: 'string',
      label: 'Email',
      required: true,
      validation: { pattern: '^[^@]+@[^@]+$' },
    });
    expect(byName.yearsOfExperience).toMatchObject({
      type: 'number',
      label: 'Years Of Experience',
      required: true,
      validation: { min: 0, max: 50 },
    });
    expect(byName.isRemote).toMatchObject({ type: 'boolean', required: false });
    expect(byName.startDate).toMatchObject({ type: 'date', required: false });
  });

  it('maps an enum schema to type "enum" with enumValues', () => {
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['employmentStatus'],
                  properties: {
                    employmentStatus: {
                      type: 'string',
                      enum: ['employed', 'unemployed'],
                    },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    expect(endpoint.fields[0]).toMatchObject({
      name: 'employmentStatus',
      type: 'enum',
      enumValues: ['employed', 'unemployed'],
      required: true,
    });
  });

  it('flattens nested object bodies into dot-notation field names', () => {
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    address: {
                      type: 'object',
                      required: ['city'],
                      properties: {
                        city: { type: 'string' },
                        zip: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    const names = endpoint.fields.map((f) => f.name).sort();
    expect(names).toEqual(['address.city', 'address.zip', 'name']);

    const city = endpoint.fields.find((f) => f.name === 'address.city');
    expect(city).toMatchObject({ label: 'City', required: true });
    const zip = endpoint.fields.find((f) => f.name === 'address.zip');
    expect(zip).toMatchObject({ label: 'Zip', required: false });
  });

  it('skips array-typed fields with a warning instead of crashing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    expect(endpoint.fields.map((f) => f.name)).toEqual(['name']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats a field with no description as undefined, not a crash', () => {
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    expect(endpoint.description).toBeUndefined();
    expect(endpoint.fields[0].description).toBeUndefined();
  });

  it('extracts query/path parameters as fields alongside the body', () => {
    const doc = baseDoc({
      '/candidates/{id}/notes': {
        post: {
          operationId: 'addNote',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'notify',
              in: 'query',
              required: false,
              schema: { type: 'boolean' },
            },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc);
    const names = endpoint.fields.map((f) => f.name).sort();
    expect(names).toEqual(['id', 'notify', 'text']);
    expect(endpoint.fields.find((f) => f.name === 'id')).toMatchObject({ required: true });
  });

  describe('security scheme extraction', () => {
    it('maps an apiKey scheme', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: {
              operationId: 'createCandidate',
              security: [{ apiKeyAuth: [] }],
              responses: {},
            },
          },
        },
        {
          components: {
            securitySchemes: {
              apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc);
      expect(endpoint.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    });

    it('maps an http bearer scheme', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: {
              operationId: 'createCandidate',
              security: [{ bearerAuth: [] }],
              responses: {},
            },
          },
        },
        {
          components: {
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer' },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc);
      expect(endpoint.auth).toEqual({ type: 'http', scheme: 'bearer' });
    });

    it('falls back to document-level security when the operation declares none', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: { operationId: 'createCandidate', responses: {} },
          },
        },
        {
          security: [{ apiKeyAuth: [] }],
          components: {
            securitySchemes: {
              apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc);
      expect(endpoint.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    });

    it('defaults to type "none" when no security is declared anywhere', () => {
      const doc = baseDoc({
        '/candidates': {
          post: { operationId: 'createCandidate', responses: {} },
        },
      });

      const [endpoint] = parseOpenApiDocument(doc);
      expect(endpoint.auth).toEqual({ type: 'none' });
    });

    it('honors an explicit empty security array as "no auth", even with doc-level security set', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: {
              operationId: 'createCandidate',
              security: [],
              responses: {},
            },
          },
        },
        {
          security: [{ apiKeyAuth: [] }],
          components: {
            securitySchemes: {
              apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc);
      expect(endpoint.auth).toEqual({ type: 'none' });
    });
  });

  it('produces endpoints that validate against ParsedEndpointSchema', () => {
    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string' } },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const endpoints = parseOpenApiDocument(doc);
    for (const endpoint of endpoints) {
      expect(ParsedEndpointSchema.safeParse(endpoint).success).toBe(true);
    }
  });
});

describe('parseOpenApiFile', () => {
  it('dereferences $ref pointers before parsing', async () => {
    const fixturePath = fileURLToPath(
      new URL('./__fixtures__/ref-example.openapi.yaml', import.meta.url)
    );

    const endpoints = await parseOpenApiFile(fixturePath);

    expect(endpoints).toHaveLength(1);
    const [endpoint] = endpoints;
    expect(endpoint.id).toBe('createWidget');
    const byName = Object.fromEntries(endpoint.fields.map((f) => [f.name, f]));
    expect(byName.name).toMatchObject({ type: 'string', required: true });
    expect(byName.quantity).toMatchObject({ type: 'number', validation: { min: 1 } });
  });
});
