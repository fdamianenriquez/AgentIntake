import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import {
  API_KEY_ENV_VAR,
  resolveProvider,
  SUPPORTED_PROVIDERS,
  type LlmProvider,
} from '../server/src/llmClient.js';

// Studio-only routes: a non-technical user picks a
// provider and pastes an API key in-browser instead of hand-editing .env.
// Deliberately NOT part of server/src/app.ts's createApp() -- that's the
// same Express app a deployer could expose as the production runtime
// wizard, and an endpoint that writes an API key to disk on
// request has no business existing on anything but a local, single-user
// Studio instance.

const ProviderSetupSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
  apiKey: z.string().min(1),
});

export function registerStudioProviderRoutes(app: Express): void {
  app.get('/api/provider-status', (_req, res) => {
    try {
      const provider = resolveProvider();
      const configured = Boolean(process.env[API_KEY_ENV_VAR]);
      res.status(200).json({ configured, provider: configured ? provider : undefined });
    } catch {
      // resolveProvider() throws on an unrecognized LLM_PROVIDER -- from
      // Studio's perspective that's just "not configured yet."
      res.status(200).json({ configured: false });
    }
  });

  app.post('/api/provider-setup', async (req, res) => {
    const parsed = ProviderSetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Request body must be { provider: string, apiKey: string }.' });
      return;
    }

    try {
      await writeProviderConfig(parsed.data.provider, parsed.data.apiKey);
      res.status(200).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

// Persists to .env (so it survives across Studio sessions
// "written to .env for reuse across sessions" option -- chosen over
// in-memory-only so a non-technical user isn't asked to re-paste their key
// every time they run `npx agent-intake studio`) and applies it to the
// current process immediately, so it takes effect without a restart.
async function writeProviderConfig(provider: LlmProvider, apiKey: string): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
  const updates: Record<string, string> = { LLM_PROVIDER: provider, [API_KEY_ENV_VAR]: apiKey };

  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, 'utf-8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const seen = new Set<string>();
  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match && match[1] in updates) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) updatedLines.push(`${key}=${value}`);
  }

  while (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === '') {
    updatedLines.pop();
  }

  await writeFile(envPath, updatedLines.join('\n') + '\n', 'utf-8');

  process.env.LLM_PROVIDER = provider;
  process.env[API_KEY_ENV_VAR] = apiKey;
}
