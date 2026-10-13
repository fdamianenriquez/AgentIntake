import { z } from 'zod';

// The JSON schema an LLM output schema becomes on the wire (the AI SDK converts
// with io: 'input'), checked against the structured-output rules the strictest
// supported providers enforce. Each rule is one a real provider rejected:
// - Anthropic: no "oneOf".
// - OpenAI strict mode: every property listed in "required" (an optional
//   field must be nullable instead), no open-ended maps, and every value
//   schema says what it is (z.unknown() becomes an empty schema).
export function portabilityProblems(schema: z.ZodType): string[] {
  const problems: string[] = [];
  walk(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, '$', problems);
  return problems;
}

function walk(node: Record<string, unknown>, at: string, problems: string[]): void {
  if ('oneOf' in node) problems.push(`${at}: uses oneOf`);

  const described = ['type', 'anyOf', 'oneOf', 'enum', 'const', '$ref', 'not'].some((key) => key in node);
  if (!described) problems.push(`${at}: schema does not say what the value is`);

  const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties) {
    const required = new Set((node.required as string[] | undefined) ?? []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) problems.push(`${at}.${key}: not required`);
    }
  }
  const extra = node.additionalProperties;
  if (extra !== undefined && extra !== false) problems.push(`${at}: open-ended map (additionalProperties)`);

  for (const [key, child] of Object.entries(properties ?? {})) walk(child, `${at}.${key}`, problems);
  if (node.items && typeof node.items === 'object') walk(node.items as Record<string, unknown>, `${at}[]`, problems);
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = node[combinator] as Record<string, unknown>[] | undefined;
    options?.forEach((option, index) => walk(option, `${at}<${combinator}${index}>`, problems));
  }
}
