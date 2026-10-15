import type { Request, Response } from 'express';
import { z } from 'zod';
import { parseOpenApiContent } from '../openapiParser.js';
import { generateFlow } from '../flowGenerator.js';
import { guidanceFor } from '../prompts/guidance.js';
import { serverContext } from '../serverContext.js';

// { specContent: string } -- the raw spec text (JSON or YAML), never a path
// or URL. This route is reachable over a network, so it must never be the
// one fetching a caller-supplied location (that's a real SSRF /
// local-file-disclosure vector, not just a style choice). Studio's
// frontend resolves a pasted URL or uploaded
// file to content in the browser first and sends that content here -- the
// server itself never resolves a location on a caller's behalf.
const RequestBodySchema = z.object({
  specContent: z.string().min(1),
});

export async function handleGenerateFlow(req: Request, res: Response): Promise<void> {
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Request body must be { specContent: string } -- the raw OpenAPI spec text (JSON or YAML), never a path or URL.',
    });
    return;
  }

  try {
    const { endpoints, warnings } = await parseOpenApiContent(parsed.data.specContent);

    if (endpoints.length === 0) {
      res.status(400).json({ error: 'No write operations (POST/PUT/PATCH) found in the given spec.' });
      return;
    }

    // Unlike the CLI (which just console.warns), a direct caller of this
    // route -- Studio -- has no terminal to read, so the parser's warnings
    // (large spec, ungrouped operations, required headers) travel in the
    // response body itself.

    const guidance = guidanceFor('generation', serverContext(res).guidance, undefined);
    const { flow, ambiguousFields } = await generateFlow({ endpoints, guidance });
    res.status(200).json({ flow, ambiguousFields, warnings });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
