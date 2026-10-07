import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import { parseOpenApiContent, parseOpenApiDocument, parseOpenApiFile, ParsedEndpointSchema } from './openapiParser.js';

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

    const endpoints = parseOpenApiDocument(doc).endpoints;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe('createWidget');
  });

  it('derives an id and title from method+path when operationId is missing', () => {
    const doc = baseDoc({
      '/candidates/{id}/notes': {
        put: { responses: {} },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
    const names = endpoint.fields.map((f) => f.name).sort();
    expect(names).toEqual(['address.city', 'address.zip', 'name']);

    const city = endpoint.fields.find((f) => f.name === 'address.city');
    expect(city).toMatchObject({ label: 'City', required: true });
    const zip = endpoint.fields.find((f) => f.name === 'address.zip');
    expect(zip).toMatchObject({ label: 'Zip', required: false });
  });

  it('stops flattening beyond the max nesting depth, with a warning instead of a crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Build a schema nested one level deeper than MAX_NESTING_DEPTH (5).
    let innermost: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: { tooDeep: { type: 'string' } },
    };
    for (let i = 0; i < 6; i++) {
      innermost = { type: 'object', properties: { level: innermost } };
    }

    const doc = baseDoc({
      '/candidates': {
        post: {
          operationId: 'createCandidate',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' }, nested: innermost } },
              },
            },
          },
          responses: {},
        },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc).endpoints;

    expect(endpoint.fields.map((f) => f.name)).toContain('name');
    expect(endpoint.fields.some((f) => f.name.endsWith('tooDeep'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('max nesting depth exceeded'));

    warn.mockRestore();
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
    expect(endpoint.description).toBeUndefined();
    expect(endpoint.fields[0].description).toBeUndefined();
  });

  it('makes query parameters fields, but lists path parameters in pathParams instead of asking for them', () => {
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

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
    expect(endpoint.fields.map((f) => f.name).sort()).toEqual(['notify', 'text']);
    expect(endpoint.pathParams).toEqual(['id']);
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

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
      expect(endpoint.auth).toEqual({ type: 'http', scheme: 'bearer' });
    });

    it('maps an oauth2 scheme', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: {
              operationId: 'createCandidate',
              security: [{ oauth2Auth: [] }],
              responses: {},
            },
          },
        },
        {
          components: {
            securitySchemes: {
              oauth2Auth: {
                type: 'oauth2',
                flows: { clientCredentials: { tokenUrl: 'https://example.com/token', scopes: {} } },
              },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
      expect(endpoint.auth).toEqual({ type: 'oauth2' });
    });

    it('maps an openIdConnect scheme', () => {
      const doc = baseDoc(
        {
          '/candidates': {
            post: {
              operationId: 'createCandidate',
              security: [{ oidcAuth: [] }],
              responses: {},
            },
          },
        },
        {
          components: {
            securitySchemes: {
              oidcAuth: { type: 'openIdConnect', openIdConnectUrl: 'https://example.com/.well-known/openid-configuration' },
            },
          },
        }
      );

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
      expect(endpoint.auth).toEqual({ type: 'openIdConnect' });
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

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
      expect(endpoint.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    });

    it('defaults to type "none" when no security is declared anywhere', () => {
      const doc = baseDoc({
        '/candidates': {
          post: { operationId: 'createCandidate', responses: {} },
        },
      });

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

      const [endpoint] = parseOpenApiDocument(doc).endpoints;
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

    const endpoints = parseOpenApiDocument(doc).endpoints;
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

    const endpoints = (await parseOpenApiFile(fixturePath)).endpoints;

    expect(endpoints).toHaveLength(1);
    const [endpoint] = endpoints;
    expect(endpoint.id).toBe('createWidget');
    const byName = Object.fromEntries(endpoint.fields.map((f) => [f.name, f]));
    expect(byName.name).toMatchObject({ type: 'string', required: true });
    expect(byName.quantity).toMatchObject({ type: 'number', validation: { min: 1 } });
  });
});

describe('parseOpenApiContent', () => {
  it('parses raw JSON/YAML text (untrusted network input), resolving only internal $refs', async () => {
    const fixturePath = fileURLToPath(new URL('./__fixtures__/ref-example.openapi.yaml', import.meta.url));
    const content = await readFile(fixturePath, 'utf-8');

    const endpoints = (await parseOpenApiContent(content)).endpoints;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe('createWidget');
    expect(endpoints[0].fields.map((f) => f.name).sort()).toEqual(['name', 'quantity']);
  });

  it(
    'SECURITY: never fetches an external URL $ref, and never reads a local file $ref',
    async () => {
      const localSecretPath = fileURLToPath(new URL('./__fixtures__/local-secret.json', import.meta.url));

      const content = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'SSRF Fixture API', version: '1.0.0' },
        paths: {
          '/widgets': {
            post: {
              operationId: 'createWidget',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        // 192.0.2.1 is a reserved, non-routable TEST-NET-1
                        // address (RFC 5737) -- if this were ever actually
                        // fetched, the request would hang until the test's
                        // own timeout below fails it, rather than silently
                        // succeeding.
                        external: { $ref: 'http://192.0.2.1/evil-schema.json#/definitions/Evil' },
                        // A real, readable local file -- proving the file
                        // is never opened, not just that a fake path fails.
                        local: { $ref: `${localSecretPath}#/definitions/Secret` },
                      },
                    },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      });

      const endpoints = (await parseOpenApiContent(content)).endpoints;
      const [endpoint] = endpoints;
      const fieldNames = endpoint.fields.map((f) => f.name);

      // Neither ref is followed -- both are left unresolved and therefore
      // dropped by schemaToFieldDef's "unsupported schema" fallback, never
      // surfacing as a usable field. The base "name" field still comes
      // through untouched.
      expect(fieldNames).toContain('name');
      expect(fieldNames).not.toContain('external');
      expect(fieldNames).not.toContain('local');
      expect(JSON.stringify(endpoints)).not.toContain('THIS_SHOULD_NEVER_APPEAR_IN_OUTPUT');
    },
    10_000
  );
});

describe('resource families', () => {
  const body = (properties: Record<string, OpenAPIV3.SchemaObject>) => ({
    content: { 'application/json': { schema: { type: 'object' as const, properties } } },
  });
  const idParam = (name: string): OpenAPIV3.ParameterObject => ({ name, in: 'path', required: true, schema: { type: 'string' } });

  it('groups POST /accounts with the operations on /accounts/{accountId} into one step', () => {
    const doc = baseDoc({
      '/accounts': { post: { operationId: 'createAccount', requestBody: body({ email: { type: 'string' } }), responses: {} } },
      '/accounts/{accountId}': {
        parameters: [idParam('accountId')],
        get: { responses: {} },
        patch: { operationId: 'updateAccount', requestBody: body({ email: { type: 'string' } }), responses: {} },
        delete: { responses: {} },
      },
    });

    const { endpoints, warnings } = parseOpenApiDocument(doc);

    expect(endpoints.map((e) => e.id)).toEqual(['createAccount']);
    expect(endpoints[0]).toMatchObject({
      resourcePath: '/accounts',
      idParam: 'accountId',
      capabilities: { read: true, update: true, undo: true },
    });
    expect(endpoints[0].pathParams).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('detects nested collections, with the parent id as a path parameter', () => {
    const doc = baseDoc({
      '/accounts/{accountId}/verifications': {
        parameters: [idParam('accountId')],
        post: { operationId: 'createVerification', requestBody: body({ dateOfBirth: { type: 'string' } }), responses: {} },
      },
      '/accounts/{accountId}/verifications/{verificationId}': {
        parameters: [idParam('accountId'), idParam('verificationId')],
        get: { responses: {} },
        put: { requestBody: body({ dateOfBirth: { type: 'string' } }), responses: {} },
      },
    });

    const [endpoint, ...rest] = parseOpenApiDocument(doc).endpoints;

    expect(rest).toEqual([]);
    expect(endpoint).toMatchObject({
      id: 'createVerification',
      pathParams: ['accountId'],
      resourcePath: '/accounts/{accountId}/verifications',
      idParam: 'verificationId',
      capabilities: { read: true, update: true, undo: false },
    });
    expect(endpoint.fields.map((f) => f.name)).toEqual(['dateOfBirth']);
  });

  it('records a partial family (undo only)', () => {
    const doc = baseDoc({
      '/payout-methods': { post: { operationId: 'createPayoutMethod', requestBody: body({ bank: { type: 'string' } }), responses: {} } },
      '/payout-methods/{payoutMethodId}': { delete: { responses: {} } },
    });

    expect(parseOpenApiDocument(doc).endpoints[0].capabilities).toEqual({ read: false, update: false, undo: true });
  });

  it('ignores an item path that has no read/update/undo operations', () => {
    const doc = baseDoc({
      '/things': { post: { operationId: 'createThing', requestBody: body({ a: { type: 'string' } }), responses: {} } },
      '/things/{id}': { post: { operationId: 'actOnThing', requestBody: body({ b: { type: 'string' } }), responses: {} } },
    });

    const { endpoints } = parseOpenApiDocument(doc);
    expect(endpoints.map((e) => e.id)).toEqual(['createThing', 'actOnThing']);
    expect(endpoints[0].capabilities).toBeUndefined();
  });

  it('keeps a PUT/PATCH outside a family as its own step, with a warning (singletons, orphan updates)', () => {
    const doc = baseDoc({
      '/me/settings': { put: { operationId: 'updateSettings', requestBody: body({ theme: { type: 'string' } }), responses: {} } },
      '/widgets/{widgetId}': {
        patch: { operationId: 'updateWidget', requestBody: body({ name: { type: 'string' } }), responses: {} },
      },
    });

    const { endpoints, warnings } = parseOpenApiDocument(doc);

    expect(endpoints.map((e) => e.id)).toEqual(['updateSettings', 'updateWidget']);
    expect(warnings).toEqual([
      expect.stringContaining('PUT /me/settings'),
      expect.stringContaining('PATCH /widgets/{widgetId}'),
    ]);
  });

  it('keeps an RPC-style action as its own step', () => {
    const doc = baseDoc({
      '/orders/{orderId}/cancel': {
        post: { operationId: 'cancelOrder', parameters: [idParam('orderId')], requestBody: body({ reason: { type: 'string' } }), responses: {} },
      },
    });

    const [endpoint] = parseOpenApiDocument(doc).endpoints;
    expect(endpoint).toMatchObject({ id: 'cancelOrder', pathParams: ['orderId'] });
    expect(endpoint.capabilities).toBeUndefined();
  });

  it('refuses to guess when several item paths match the same collection', () => {
    const doc = baseDoc({
      '/things': { post: { operationId: 'createThing', requestBody: body({ a: { type: 'string' } }), responses: {} } },
      '/things/{id}': { get: { responses: {} } },
      '/things/{slug}': { delete: { responses: {} } },
    });

    const { endpoints, warnings } = parseOpenApiDocument(doc);
    expect(endpoints[0].capabilities).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('matches several item paths')]);
  });

  it('reports the large-spec warning through the same warnings channel', () => {
    const paths: OpenAPIV3.PathsObject = {};
    for (let i = 0; i < 16; i++) {
      paths[`/things${i}`] = { post: { operationId: `create${i}`, requestBody: body({ a: { type: 'string' } }), responses: {} } };
    }
    expect(parseOpenApiDocument(baseDoc(paths)).warnings).toEqual([expect.stringContaining('Found 16 write operations')]);
  });
});

describe('parameters', () => {
  const op = (parameters: OpenAPIV3.ParameterObject[], security?: OpenAPIV3.SecurityRequirementObject[]) => ({
    operationId: 'createThing',
    parameters,
    ...(security ? { security } : {}),
    requestBody: { content: { 'application/json': { schema: { type: 'object' as const, properties: { a: { type: 'string' as const } } } } } },
    responses: {},
  });

  it('never turns header or cookie parameters into fields', () => {
    const doc = baseDoc({
      '/things': {
        post: op([
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ]),
      },
    });

    const { endpoints, warnings } = parseOpenApiDocument(doc);
    expect(endpoints[0].fields.map((f) => f.name)).toEqual(['a']);
    expect(warnings).toEqual([]);
  });

  it('warns about a required header the security scheme does not cover', () => {
    const doc = baseDoc({
      '/things': { post: op([{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }]) },
    });

    expect(parseOpenApiDocument(doc).warnings).toEqual([
      'POST /things requires the header "Idempotency-Key". It isn\'t asked for in the form; send it from your operations.',
    ]);
  });

  it('does not warn about a required header that is the auth credential itself', () => {
    const doc = baseDoc(
      {
        '/things': {
          post: op(
            [
              { name: 'X-API-Key', in: 'header', required: true, schema: { type: 'string' } },
            ],
            [{ apiKeyAuth: [] }]
          ),
        },
        '/others': {
          post: {
            ...op([{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } }], [{ bearer: [] }]),
            operationId: 'createOther',
          },
        },
      },
      {
        components: {
          securitySchemes: {
            apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            bearer: { type: 'http', scheme: 'bearer' },
          },
        },
      }
    );

    expect(parseOpenApiDocument(doc).warnings).toEqual([]);
  });

  it('merges path-item parameters, with operation-level ones taking precedence', () => {
    const doc = baseDoc({
      '/things': {
        parameters: [
          { name: 'dryRun', in: 'query', schema: { type: 'boolean' } },
          { name: 'locale', in: 'query', required: false, schema: { type: 'string' } },
        ],
        post: op([{ name: 'locale', in: 'query', required: true, schema: { type: 'string' } }]),
      },
    });

    const { fields } = parseOpenApiDocument(doc).endpoints[0];
    expect(fields.map((f) => f.name).sort()).toEqual(['a', 'dryRun', 'locale']);
    expect(fields.find((f) => f.name === 'locale')?.required).toBe(true);
  });
});
