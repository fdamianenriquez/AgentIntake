import type { Request, Response } from 'express';
import { z } from 'zod';
import { largeSpecWarning, parseOpenApiFile } from '../openapiParser.js';
import { generateFlow } from '../flowGenerator.js';

// Only { spec: string } (a path or URL, same as the CLI's --spec) is
// supported for now -- pasting raw spec text is Studio's job, which
// needs its own input validation/friendly errors and
// isn't built yet. This route already covers what Studio's "Generate"
// button needs once that text gets parsed into the same shape.
const RequestBodySchema = z.object({
  spec: z.string().min(1),
});

export async function handleGenerateFlow(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Request body must be { spec: string } (a path or URL to an OpenAPI 3.x spec).' });
    return;
  }

  try {
    const endpoints = await parseOpenApiFile(parsed.data.spec);

    if (endpoints.length === 0) {
      res.status(400).json({ error: `No write operations (POST/PUT/PATCH) found in "${parsed.data.spec}".` });
      return;
    }

    // Unlike the CLI (which just console.warns), a direct caller of this
    // route -- Studio, once it exists -- has no terminal to read, so
    // the large-spec warning has to travel in the response body itself.
    const warning = largeSpecWarning(endpoints.length);
    const warnings = warning ? [warning] : [];

    const { flow, ambiguousFields } = await generateFlow({ endpoints });
    res.status(200).json({ flow, ambiguousFields, warnings });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
