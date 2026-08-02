import type { EndpointDef } from './flowSchema.js';

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function isValidDate(value: unknown): boolean {
  if (typeof value === 'string') {
    return !Number.isNaN(Date.parse(value));
  }
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  return false;
}

/**
 * Pure validation of tool-call arguments against a flow's field definitions.
 * Returns a list of human-readable error messages (empty when valid).
 */
export function validateEndpointInput(
  endpoint: EndpointDef,
  input: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  for (const field of endpoint.fields) {
    const value = input[field.name];

    if (isMissing(value)) {
      if (field.required) {
        errors.push(`"${field.name}" is required`);
      }
      continue;
    }

    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') {
          errors.push(`"${field.name}" must be a string`);
          break;
        }
        if (field.validation?.pattern) {
          const regex = new RegExp(field.validation.pattern);
          if (!regex.test(value)) {
            errors.push(`"${field.name}" does not match the required format`);
          }
        }
        if (field.validation?.min !== undefined && value.length < field.validation.min) {
          errors.push(`"${field.name}" must be at least ${field.validation.min} characters`);
        }
        if (field.validation?.max !== undefined && value.length > field.validation.max) {
          errors.push(`"${field.name}" must be at most ${field.validation.max} characters`);
        }
        break;
      }

      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push(`"${field.name}" must be a number`);
          break;
        }
        if (field.validation?.min !== undefined && value < field.validation.min) {
          errors.push(`"${field.name}" must be at least ${field.validation.min}`);
        }
        if (field.validation?.max !== undefined && value > field.validation.max) {
          errors.push(`"${field.name}" must be at most ${field.validation.max}`);
        }
        break;
      }

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`"${field.name}" must be a boolean`);
        }
        break;

      case 'date':
        if (!isValidDate(value)) {
          errors.push(`"${field.name}" must be a valid date`);
        }
        break;

      case 'enum': {
        if (!field.enumValues || !field.enumValues.includes(String(value))) {
          errors.push(`"${field.name}" must be one of: ${(field.enumValues ?? []).join(', ')}`);
        }
        break;
      }
    }
  }

  return errors;
}
