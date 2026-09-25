import path from 'node:path';
import { createApp } from './app.js';

// .env at the project root -- read the same way as the CLI.
// Already-set environment
// variables are left untouched.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`AgentIntake server listening on http://localhost:${port}`);
});
