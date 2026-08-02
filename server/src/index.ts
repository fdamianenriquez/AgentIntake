import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createModelProvider } from './provider/index.js';
import { Orchestrator } from './orchestrator.js';
import { createConversationRouter } from './routes/conversation.js';
import { flows } from './flows/exampleFlow.js';

const port = Number(process.env.PORT ?? 4000);

const provider = createModelProvider({
  provider: process.env.AI_PROVIDER,
  apiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  model: process.env.AI_MODEL || process.env.ANTHROPIC_MODEL,
  baseUrl: process.env.AI_BASE_URL,
});

const orchestrator = new Orchestrator({ provider });

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', createConversationRouter(orchestrator, flows));

app.listen(port, () => {
  console.log(`AgentIntake server listening on http://localhost:${port}`);
  console.log(`  Provider: ${process.env.AI_PROVIDER ?? 'anthropic'}`);
  console.log(`  Flows available: ${Object.keys(flows).join(', ')}`);
  if (!process.env.AI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.warn(
      'WARNING: No AI_API_KEY set. The server will start, but model calls will fail.\n' +
        '  Copy server/.env.example to server/.env and add your key.',
    );
  }
});
