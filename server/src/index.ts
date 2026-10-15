import path from 'node:path';
import { createApp } from './app.js';

// .env at the project root -- read the same way as the CLI. Already-set environment
// variables are left untouched.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT ?? 3000);
let app: ReturnType<typeof createApp>;
try {
  app = createApp();
} catch (error) {
  // A configuration error (for example a bad AGENTINTAKE_CORS_ORIGINS entry):
  // say what is wrong, without a stack trace.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

app.listen(port, () => {
  console.log(`AgentIntake server listening on http://localhost:${port}`);
});
