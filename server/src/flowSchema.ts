export interface FieldValidation {
  pattern?: string;
  min?: number;
  max?: number;
}

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

export interface FieldDef {
  name: string;
  type: FieldType;
  description: string;
  required: boolean;
  enumValues?: string[];
  validation?: FieldValidation;
}

export interface ExecuteResult {
  success: boolean;
  message?: string;
}

export interface EndpointDef {
  id: string;
  description: string;
  fields: FieldDef[];
  execute: (data: Record<string, unknown>) => Promise<ExecuteResult>;
}

export interface FlowDef {
  id: string;
  title: string;
  description: string;
  endpoints: EndpointDef[];
}
