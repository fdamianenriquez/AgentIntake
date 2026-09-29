import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../../server/src/app.js';
import { registerStudioProviderRoutes } from '../studioProviderRoutes.js';

export interface StudioOptions {
  port?: string;
  open?: boolean;
}

// `npx agent-intake studio`: one command, no separate backend
// to start by hand -- the shared API routes (createApp()) and the Studio
// frontend (served via Vite's dev server in middleware mode, so no prebuilt
// bundle needs to ship in the npm package) run in the same Express app, on
// one port.
export async function runStudio(options: StudioOptions): Promise<void> {
  const port = Number(options.port ?? 4000);
  // Three levels up, not two: this file compiles to dist/cli/commands/
  // studio.js, but studio/ (its .tsx/.html source -- Vite reads that
  // directly, it never gets compiled into dist/) lives at the repo root,
  // one level above dist/ itself.
  const studioRoot = fileURLToPath(new URL('../../../studio', import.meta.url));

  const app = createApp();
  registerStudioProviderRoutes(app);

  const vite = await createViteServer({
    root: studioRoot,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`AgentIntake Studio running at ${url}`);
      if (options.open !== false) openInBrowser(url);
      resolve();
    });
  });
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  execFile(command, args, (error) => {
    if (error) {
      console.warn(`Could not automatically open a browser -- open ${url} manually.`);
    }
  });
}

export function registerStudioCommand(program: Command): void {
  program
    .command('studio')
    .description('Launch AgentIntake Studio, a local web UI for generating and previewing a flow')
    .option('--port <port>', 'Port to run Studio on', '4000')
    .option('--no-open', "Don't automatically open a browser")
    .action(async (opts: StudioOptions) => {
      await runStudio(opts);
    });
}
