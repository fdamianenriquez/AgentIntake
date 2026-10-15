import type { FieldDef } from '../contracts.js';

export interface FieldControlProps {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  suggested?: boolean;
  disabled?: boolean;
}

// Fully generic (FieldDef.type -> control mapping), with no hardcoded
// per-field JSX: one switch on `field.type`, nothing that knows
// about any specific field by name.
export function FieldControl({ field, value, onChange, error, suggested, disabled }: FieldControlProps) {
  return (
    <div className="agent-intake-field" data-suggested={suggested ? 'true' : undefined}>
      <label htmlFor={field.name}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      {field.description && <p className="agent-intake-field-description">{field.description}</p>}
      {renderControl(field, value, onChange, Boolean(error), Boolean(disabled))}
      {suggested && <span className="agent-intake-field-suggested-badge">AI-suggested</span>}
      {error && (
        <p className="agent-intake-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function renderControl(field: FieldDef, value: unknown, onChange: (value: unknown) => void, invalid: boolean, disabled: boolean) {
  const common = {
    id: field.name,
    name: field.name,
    required: field.required,
    disabled,
    'aria-invalid': invalid ? true : undefined,
  };

  switch (field.type) {
    case 'boolean':
      return <input {...common} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;

    case 'number':
      return (
        <input
          {...common}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={field.validation?.min}
          max={field.validation?.max}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
      );

    case 'date':
      return <input {...common} type="date" value={(value as string) ?? ''} onChange={(event) => onChange(event.target.value)} />;

    case 'enum':
      return (
        <select {...common} value={(value as string) ?? ''} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>
            Select…
          </option>
          {(field.enumValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case 'string':
    default:
      return (
        <input
          {...common}
          type="text"
          pattern={field.validation?.pattern}
          value={(value as string) ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
