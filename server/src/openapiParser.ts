import SwaggerParser from '@apidevtools/swagger-parser';
import { load as loadYaml } from 'js-yaml';
import type { OpenAPIV3 } from 'openapi-types';
import {
  type AuthRequirement,
  type EndpointCapabilities,
  type FieldDef,
  type ParsedEndpoint,
} from '../../packages/react-agent-intake/src/contracts.js';

export { ParsedEndpointSchema, type ParsedEndpoint } from '../../packages/react-agent-intake/src/contracts.js';

const WRITE_METHODS = ['post', 'put', 'patch'] as const;
type WriteMethod = (typeof WRITE_METHODS)[number];

const MAX_NESTING_DEPTH = 5;

// The generator is tuned for a handful of related write operations; beyond
// that, a single enrichment prompt may not group/reason reliably. Chunked
// generation would lift this -- for now it is a visible warning, not a
// block (README: "Known operational boundaries"). Shared by every caller of
// parseOpenApiDocument/parseOpenApiFile (the CLI, and the /api/generate-flow
// route) so the message and threshold can't drift between them.
export const LARGE_SPEC_ENDPOINT_THRESHOLD = 15;

export function largeSpecWarning(endpointCount: number): string | null {
  if (endpointCount <= LARGE_SPEC_ENDPOINT_THRESHOLD) return null;
  return `Found ${endpointCount} write operations, more than AgentIntake v1 is tuned for (~${LARGE_SPEC_ENDPOINT_THRESHOLD}). Generation quality may degrade for large specs.`;
}

export interface ParseResult {
  endpoints: ParsedEndpoint[];
  /** Things the author should know about, e.g. operations that couldn't be grouped. */
  warnings: string[];
}

interface ResourceFamily {
  itemPath: string;
  idParam: string;
  capabilities: EndpointCapabilities;
}

// An item path is exactly the collection path plus one segment
// that is a single path parameter -- `/accounts/{accountId}` for
// `/accounts`. Returns that parameter's name, or null.
function itemParamOf(itemPath: string, collectionPath: string): string | null {
  const match = itemPath.match(/^(.*)\/\{([^{}/]+)\}$/);
  return match && match[1] === collectionPath ? match[2] : null;
}

function findResourceFamilies(paths: OpenAPIV3.PathsObject, warnings: string[]): Map<string, ResourceFamily> {
  const families = new Map<string, ResourceFamily>();

  for (const [collectionPath, pathItem] of Object.entries(paths)) {
    if (!pathItem?.post) continue;

    const candidates = Object.keys(paths).filter((path) => itemParamOf(path, collectionPath) !== null);
    if (candidates.length > 1) {
      warnings.push(
        `POST ${collectionPath} matches several item paths (${candidates.join(', ')}); read/update/undo were not attached to it.`
      );
      continue;
    }
    if (candidates.length === 0) continue;

    const itemPath = candidates[0];
    const item = paths[itemPath];
    const capabilities = {
      read: Boolean(item?.get),
      update: Boolean(item?.put || item?.patch),
      undo: Boolean(item?.delete),
    };
    if (!capabilities.read && !capabilities.update && !capabilities.undo) continue;

    families.set(collectionPath, { itemPath, idParam: itemParamOf(itemPath, collectionPath)!, capabilities });
  }

  return families;
}

// OpenAPI allows parameters on the path item, shared by every operation on it;
// an operation-level parameter with the same name and location overrides one.
function mergeParameters(pathLevel: OpenAPIV3.ParameterObject[], operationLevel: OpenAPIV3.ParameterObject[]): OpenAPIV3.ParameterObject[] {
  const merged = new Map<string, OpenAPIV3.ParameterObject>();
  for (const param of [...pathLevel, ...operationLevel]) merged.set(`${param.in}:${param.name}`, param);
  return [...merged.values()];
}

function pathTemplateParams(path: string): string[] {
  return [...path.matchAll(/\{([^{}/]+)\}/g)].map((match) => match[1]);
}

function headerCoveredByAuth(name: string, auth: AuthRequirement): boolean {
  const lower = name.toLowerCase();
  if (auth.type === 'apiKey') return auth.in === 'header' && auth.name?.toLowerCase() === lower;
  if (auth.type === 'http' || auth.type === 'oauth2' || auth.type === 'openIdConnect') return lower === 'authorization';
  return false;
}

/**
 * Parses an already-dereferenced OpenAPI 3.x document into a raw, unenriched
 * list of endpoints (one per write operation that isn't part of a resource
 * family's item path). No LLM involved -- this is pure mechanical extraction.
 * Base schema enrichment (grouping, labels, descriptions, ambiguous-field
 * flags) happens later in flowGenerator.ts.
 *
 * Resource families (README: "How the spec becomes steps"): `POST /things` plus the operations on
 * `/things/{id}` form one step. GET/PUT/PATCH/DELETE on the item path become
 * that step's `capabilities` (read/update/undo) instead of steps of their own.
 *
 * Parameters: only query parameters become form fields. Path
 * parameters are ids the flow author fills in from earlier results (listed in
 * `pathParams`), and header/cookie parameters are transport concerns -- neither
 * is something to ask the person filling out the form.
 */
export function parseOpenApiDocument(doc: OpenAPIV3.Document): ParseResult {
  if (!doc.openapi || !doc.openapi.startsWith('3.')) {
    throw new Error(`AgentIntake only supports OpenAPI 3.x specs (got openapi: "${doc.openapi ?? 'unknown'}")`);
  }

  const securitySchemes = doc.components?.securitySchemes as Record<string, OpenAPIV3.SecuritySchemeObject> | undefined;

  const paths = doc.paths ?? {};
  const warnings: string[] = [];
  const families = findResourceFamilies(paths, warnings);
  const absorbedItemPaths = new Set([...families.values()].map((family) => family.itemPath));

  const endpoints: ParsedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;

    for (const method of WRITE_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const label = `${method.toUpperCase()} ${path}`;
      if (method !== 'post' && absorbedItemPaths.has(path)) continue;
      if (method !== 'post') {
        warnings.push(
          `${label} isn't the update operation of a resource family (no POST on the matching collection path), so it stays a separate step.`
        );
      }

      const auth = extractAuthRequirement(operation.security ?? doc.security, securitySchemes);
      const parameters = mergeParameters(
        (pathItem.parameters ?? []) as OpenAPIV3.ParameterObject[],
        (operation.parameters ?? []) as OpenAPIV3.ParameterObject[]
      );

      const fields: FieldDef[] = [];
      for (const param of parameters) {
        if (param.in === 'header' || param.in === 'cookie') {
          if (param.required && !(param.in === 'header' && headerCoveredByAuth(param.name, auth))) {
            warnings.push(
              `${label} requires the ${param.in} "${param.name}". It isn't asked for in the form; send it from your operations.`
            );
          }
          continue;
        }
        if (param.in !== 'query' || !param.schema) continue;
        const field = schemaToFieldDef(param.name, param.schema as OpenAPIV3.SchemaObject, param.required ?? false, param.description);
        if (field) fields.push(field);
      }

      const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
      const bodySchema = requestBody?.content?.['application/json']?.schema as OpenAPIV3.SchemaObject | undefined;
      if (bodySchema) {
        flattenSchemaToFields(bodySchema, '', 0, fields);
      }

      const pathParams = pathTemplateParams(path);
      const family = method === 'post' ? families.get(path) : undefined;

      endpoints.push({
        id: operation.operationId ?? deriveEndpointId(method, path),
        title: operation.summary ?? label,
        description: operation.description,
        fields,
        auth,
        ...(pathParams.length > 0 ? { pathParams } : {}),
        ...(family ? { resourcePath: path, idParam: family.idParam, capabilities: family.capabilities } : {}),
      });
    }
  }

  const largeSpec = largeSpecWarning(endpoints.length);
  if (largeSpec) warnings.push(largeSpec);

  return { endpoints, warnings };
}

// Two entry points, trusted differently:
//
// - parseOpenApiFile is for the CLI only, where the developer running it
//   already chose and controls the path/URL -- fully dereferences $refs,
//   including external file/HTTP ones.
// - parseOpenApiContent is for /api/generate-flow and Studio, where the
//   input arrives from a network caller and can't be trusted the same way.
//   Passing a caller-supplied path/URL to a resolver that fetches it is a
//   real SSRF / local-file-disclosure vector (reading arbitrary local
//   files, or reaching internal-only addresses on the deployer's behalf,
//   including cloud metadata endpoints) -- so this NEVER takes a path or
//   URL, only the spec's own text, and resolves it with external $ref
//   resolution disabled. Internal `#/components/...` refs still resolve
//   normally (that's just pointer lookup within the same document, no
//   resolver plugin -- and therefore no fetch -- involved).

/** Loads and $ref-dereferences a spec from a file path or URL, then parses it. */
export async function parseOpenApiFile(pathOrUrl: string): Promise<ParseResult> {
  const dereferenced = await SwaggerParser.dereference(pathOrUrl);
  return parseOpenApiDocument(dereferenced as OpenAPIV3.Document);
}

/**
 * Parses raw spec text (JSON or YAML) from an untrusted network caller.
 * External (file/HTTP) `$ref`s are never resolved -- `resolve.external:
 * false` is json-schema-ref-parser's own documented option for this
 * ("external $ref pointers will simply be ignored"), not a guessed name.
 */
export async function parseOpenApiContent(content: string): Promise<ParseResult> {
  const rawDoc = parseSpecText(content);
  const dereferenced = await SwaggerParser.dereference(rawDoc as OpenAPIV3.Document, {
    resolve: { external: false },
  });
  return parseOpenApiDocument(dereferenced as OpenAPIV3.Document);
}

function parseSpecText(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // load (not loadAll) uses js-yaml's default-safe schema -- no
    // arbitrary JS object instantiation via custom tags.
    return loadYaml(content);
  }
}

function deriveEndpointId(method: WriteMethod, path: string): string {
  const slug = path
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${method}-${slug}`;
}

function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Nested object properties are flattened into dot-notation field names
// (e.g. "address.city") since FieldDef has no nested/object type -- each
// flattened leaf becomes its own real form control. A field's `required` is
// taken from its own level's `required` array only; it isn't multiplied by
// whether an ancestor object itself is required, which would make an
// otherwise-required leaf field ambiguous when its parent is optional.
function flattenSchemaToFields(schema: OpenAPIV3.SchemaObject, prefix: string, depth: number, out: FieldDef[]): void {
  if (depth > MAX_NESTING_DEPTH) {
    console.warn(`openapiParser: max nesting depth exceeded at "${prefix}", skipping deeper fields`);
    return;
  }

  const required = new Set('required' in schema ? (schema.required ?? []) : []);
  const properties = 'properties' in schema ? (schema.properties ?? {}) : {};

  for (const [propName, rawPropSchema] of Object.entries(properties)) {
    const propSchema = rawPropSchema as OpenAPIV3.SchemaObject;
    const fieldName = prefix ? `${prefix}.${propName}` : propName;

    if (propSchema.type === 'object' && 'properties' in propSchema && propSchema.properties) {
      flattenSchemaToFields(propSchema, fieldName, depth + 1, out);
      continue;
    }

    if (propSchema.type === 'array') {
      console.warn(`openapiParser: array field "${fieldName}" is not supported in v1, skipping`);
      continue;
    }

    const field = schemaToFieldDef(fieldName, propSchema, required.has(propName), propSchema.description);
    if (field) out.push(field);
  }
}

function schemaToFieldDef(name: string, schema: OpenAPIV3.SchemaObject, required: boolean, description?: string): FieldDef | null {
  const label = humanize(name.split('.').pop() ?? name);

  if (schema.enum && schema.enum.length > 0) {
    return {
      name,
      type: 'enum',
      label,
      description,
      required,
      enumValues: schema.enum.map(String),
    };
  }

  if (schema.type === 'string' && (schema.format === 'date' || schema.format === 'date-time')) {
    return { name, type: 'date', label, description, required };
  }

  if (schema.type === 'string') {
    return {
      name,
      type: 'string',
      label,
      description,
      required,
      validation: schema.pattern ? { pattern: schema.pattern } : undefined,
    };
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const hasRange = schema.minimum !== undefined || schema.maximum !== undefined;
    return {
      name,
      type: 'number',
      label,
      description,
      required,
      validation: hasRange ? { min: schema.minimum, max: schema.maximum } : undefined,
    };
  }

  if (schema.type === 'boolean') {
    return { name, type: 'boolean', label, description, required };
  }

  console.warn(`openapiParser: unsupported schema for field "${name}" (type: ${schema.type ?? 'unknown'}), skipping`);
  return null;
}

// AgentIntake's AuthRequirement models exactly one scheme. A "security" array
// entry can itself require several schemes combined with AND (multiple keys
// in one object) or offer several OR'd alternatives (multiple array entries);
// v1 doesn't attempt to represent that full boolean expression, so it takes
// the first scheme of the first alternative as a reasonable single summary.
function extractAuthRequirement(
  security: OpenAPIV3.SecurityRequirementObject[] | undefined,
  schemes: Record<string, OpenAPIV3.SecuritySchemeObject> | undefined
): AuthRequirement {
  if (!security || security.length === 0) return { type: 'none' };

  const schemeName = Object.keys(security[0] ?? {})[0];
  const scheme = schemeName ? schemes?.[schemeName] : undefined;
  if (!scheme) return { type: 'none' };

  switch (scheme.type) {
    case 'apiKey':
      return {
        type: 'apiKey',
        in: isParamLocation(scheme.in) ? scheme.in : undefined,
        name: scheme.name,
      };
    case 'http':
      return { type: 'http', scheme: scheme.scheme };
    case 'oauth2':
      return { type: 'oauth2' };
    case 'openIdConnect':
      return { type: 'openIdConnect' };
    default:
      return { type: 'none' };
  }
}

function isParamLocation(value: string): value is 'header' | 'query' | 'cookie' {
  return value === 'header' || value === 'query' || value === 'cookie';
}
