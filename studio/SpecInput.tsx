import { useState } from 'react';
import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';
import { FlowGenerationResultSchema } from '../server/src/flowGenerator.js';

const GenerateResponseSchema = FlowGenerationResultSchema.extend({
  warnings: z.array(z.string()),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export interface SpecInputProps {
  onGenerated: (result: GenerateResponse) => void;
}

type InputMode = 'text' | 'url' | 'file';

// The server must never fetch a caller-supplied path/URL
// itself. Whichever input mode is used, this always resolves to spec
// *content* in the browser first (fetching a pasted URL, or reading an
// uploaded file, right here) and only ever sends that content onward.
function looksLikeOpenApi(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = loadYaml(text);
    } catch {
      return false;
    }
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).openapi === 'string' &&
    (parsed as Record<string, string>).openapi.startsWith('3.')
  );
}

export function SpecInput({ onGenerated }: SpecInputProps) {
  const [mode, setMode] = useState<InputMode>('text');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolveContent(): Promise<string> {
    if (mode === 'url') {
      if (!url.trim()) throw new Error('Paste a spec URL first.');
      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        throw new Error("Couldn't reach that URL.");
      }
      if (!response.ok) throw new Error(`Couldn't reach that URL (HTTP ${response.status}).`);
      return response.text();
    }

    if (mode === 'file') {
      if (!file) throw new Error('Choose a file first.');
      return file.text();
    }

    if (!text.trim()) throw new Error('Paste a spec first.');
    return text;
  }

  async function handleGenerate() {
    setLoading(true);
    setError(null);

    try {
      const content = await resolveContent();

      if (!looksLikeOpenApi(content)) {
        throw new Error("This doesn't look like a valid OpenAPI file.");
      }

      const response = await fetch('/api/generate-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specContent: content }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `Generation failed (HTTP ${response.status}).`);
      }

      onGenerated(GenerateResponseSchema.parse(body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="studio-input">
      <h2>Generate a flow from an OpenAPI spec</h2>

      <div className="studio-input-mode">
        <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
          Paste text
        </button>
        <button type="button" aria-pressed={mode === 'url'} onClick={() => setMode('url')}>
          Paste a URL
        </button>
        <button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')}>
          Upload a file
        </button>
      </div>

      {mode === 'text' && (
        <textarea
          rows={14}
          placeholder="Paste your OpenAPI spec here (JSON or YAML)…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {mode === 'url' && (
        <input
          type="url"
          placeholder="https://example.com/openapi.yaml"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      )}
      {mode === 'file' && (
        <input
          type="file"
          accept=".json,.yaml,.yml,application/json,text/yaml"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      )}

      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}

      <button type="button" onClick={handleGenerate} disabled={loading}>
        {loading ? 'Generating…' : 'Generate'}
      </button>
    </section>
  );
}
