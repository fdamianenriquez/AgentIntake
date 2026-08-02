# AgentIntake

Replace multi-step forms with **one conversation**. Define what each backend endpoint/microservice needs as a schema, and an AI agent (Claude, GPT, or any model provider) chats with the user to collect it — asking only what's missing, validating as it goes, and calling the right endpoints in the right order the moment each one's fields are ready.

```
 Browser (React)           Node backend (AgentIntake)              Model provider
 +-----------------+       +--------------------------+           +----------------+
 | useAgentForm    |       | POST /api/conversation   | tool use  | Claude (Anthropic)|
 | AgentChatUI     |  <->  |   { sessionId, message } | --------> | OpenAI / OpenRouter|
 | (live endpoint  |       |                          |           | Groq / local vLLM |
 |  checklist)     |       | Orchestrator             | <-------- |  ...any provider |
 +-----------------+       |  - builds tools from     | results   +----------------+
                           |    flow schema           |
                           |  - validates arguments   |
                           |  - calls execute()       |
                           +------------|-------------+
                                        |  execute() (server-side, in your code)
                                        v
                          your microservices / endpoint contracts
```

> **Security decision (non-negotiable):** the model provider's API key **never touches the browser**. Every LLM call happens server-side in the Node backend. The React hook only talks to your own server over HTTP. This is both a security requirement and how this would be built in production.

---

## How this differs from ConvoForm

[ConvoForm](https://github.com/growupanand/ConvoForm) is an excellent AI-powered conversational form platform (one form → one destination, schema AI-generated from a text description). AgentIntake targets a different, narrower problem:

| | ConvoForm | AgentIntake |
|---|---|---|
| Core unit | One form → one destination | One conversation → **multiple independent endpoints/microservices**, each with its own contract |
| Distribution | Hosted SaaS / self-hosted full platform (own DB, auth, dashboard) | Headless library you drop into **your own** backend — closer to `react-hook-form` than to Typeform |
| Schema origin | AI-generated from a natural-language description | Developer-defined in code (`FlowDef`/`EndpointDef`), typed and testable — "config-driven," not "AI-guessed" |
| Target use case | Surveys, lead gen, HR forms | Multi-service enterprise flows (the pattern behind real production insurance/fintech onboarding flows) |

## The problem

Traditional apps that need data from multiple backend endpoints (e.g. "create a policy" touching a customer-info service, a vehicle-info service, and a payment service) force the user through several screens/forms — one per endpoint — even when the data is related and could be gathered in a single natural conversation.

## The solution

AgentIntake lets a developer describe each endpoint's contract as a schema. The orchestrator converts those schemas into tool definitions for the model provider, runs the conversation, validates every tool call before it goes anywhere, and fires each endpoint independently as soon as its fields are valid.

## How the flow schema works

```ts
export interface FieldDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  description: string;        // guides what the agent asks the user
  required: boolean;
  enumValues?: string[];       // for type: 'enum'
  validation?: { pattern?: string; min?: number; max?: number };
}

export interface EndpointDef {
  id: string;                  // the tool name the agent can call
  description: string;
  fields: FieldDef[];
  execute: (data: Record<string, unknown>) => Promise<{ success: boolean; message?: string }>;
}

export interface FlowDef {
  id: string;
  title: string;
  description: string;         // sets the agent's system prompt context
  endpoints: EndpointDef[];    // order matters if endpoints have dependencies
}
```

Each `EndpointDef` becomes one tool the agent can call. `execute` is the integration point where a real app would call its actual microservice; in the demo it just logs and resolves.

## Model providers (any provider, not just Anthropic)

The orchestrator talks to a provider-agnostic `ModelProvider` interface (`server/src/provider/types.ts`). Adapters translate that into each provider's native tool-calling format, so swapping providers is a config change, not a code change:

- **`anthropic`** (default) — Claude, via the Anthropic SDK
- **`openai`** — OpenAI
- **`openrouter`** — OpenRouter (OpenAI-compatible API, many free/cheap models)
- **`openai-compatible`** — any OpenAI-compatible endpoint (Groq, Together, vLLM, local Ollama, ...)

Configure via `server/.env` (see `server/.env.example`):

```bash
AI_PROVIDER=openrouter
AI_API_KEY=sk-or-v1-...
AI_MODEL=openrouter/auto        # or e.g. meta-llama/llama-3.3-70b-instruct:free
# AI_BASE_URL=                  # override the default endpoint if needed

# legacy names still work as fallbacks:
# ANTHROPIC_API_KEY=            # used when AI_API_KEY is not set
# ANTHROPIC_MODEL=
```

Default models per provider: `anthropic` → `claude-3-5-haiku-latest`, `openai` → `gpt-4o-mini`, `openrouter` → `openrouter/auto`. `openai-compatible` requires an explicit `AI_MODEL`.

Adding a new provider is a single class implementing `ModelProvider` (`create(request) → ModelResponse`) plus one entry in the factory (`server/src/provider/index.ts`).

## Quickstart

Requires Node 20+ and an API key for your chosen provider.

```bash
npm install
cp server/.env.example server/.env   # add AI_PROVIDER / AI_API_KEY / AI_MODEL
npm run dev                          # starts server (:4000) + demo (:5173)
```

Open http://localhost:5173 and have a conversation with the **Job Application Intake** flow — a chat replacement for a 3-page job application form (candidate info → work preferences → availability). Watch the checklist tick off **mid-conversation** as each endpoint fires independently, and check the `server` console for the `execute()` calls.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server + demo, both with hot reload |
| `npm test` | Unit tests (server validation + orchestrator, React hook) |
| `npm run typecheck` | Type-check all three packages |
| `npm run build` | Emit `server/dist`, `react-agent-intake/dist`, demo `dist/` |

### The demo flow

`job_application_intake` has three endpoints:

1. `submit_candidate_info` — name, email, years of experience, current location (email is regex-validated)
2. `submit_work_preferences` — desired role, remote/hybrid/onsite enum, salary range
3. `submit_availability` — earliest start date, notice period

Each `execute()` logs to the server console and resolves — no real backend integration needed for the demo.

## API reference

### `POST /api/conversation`

```ts
// Request
{ sessionId: string; flowId: string; message: string }

// Response
{
  reply: string;
  isComplete: boolean;
  completedEndpoints: string[];
  totalEndpoints: number;
}
```

### `useAgentForm`

```ts
function useAgentForm(options: {
  apiUrl: string;      // your backend's POST /api/conversation endpoint
  flowId: string;
}): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  sendMessage: (text: string) => Promise<void>;
  isComplete: boolean;
  completedEndpoints: string[];
  totalEndpoints: number;
  loading: boolean;
  error: Error | null;
  reset: () => void;
};
```

Manages `sessionId` internally (generated on first send) and posts to your backend — the LLM API key is never involved client-side.

### `AgentChatUI`

Optional pre-built chat component consuming `useAgentForm`. The **live endpoint checklist** is the key visual proof of the concept: each entry ticks off as soon as its endpoint fires mid-conversation — well before the intake ends — showing these are separate calls to separate services, not one form with one submit button. Populate `endpoints` from `GET /api/flows`.

## Demo

> 📸 *Demo GIF placeholder: record a short conversation on http://localhost:5173 showing the checklist ticking off endpoint-by-endpoint mid-conversation, and add it here.*

## Known limitations / Roadmap

v1 keeps scope tight on purpose. Explicitly out of scope for now:

- **Session persistence** — conversation state lives in-memory (`Map<sessionId, ConversationState>`). Restarting the server drops sessions; a Redis/DB-backed store is the natural next step.
- **LangGraph** — the hand-rolled orchestration loop (tool-calling + validation + completion tracking) works end-to-end today. If the state machine gets complex enough to justify it, swapping to LangGraph (nodes per endpoint, conditional edges on validation) is a v2 story.
- **Streaming responses** — responses return in full; token-by-token streaming is a v2 item.
- **Multi-flow intent detection** — a session is bound to one `flowId`; a v2 agent could pick the flow from user intent.
- **Channel-agnostic adapters** — because the orchestrator only exchanges `{ sessionId, message }` over HTTP, the same backend could power a Slack/Telegram/SMS bot via a thin adapter, with zero changes to orchestration logic.
- **Publishing `react-agent-intake` to npm** — the package is publishable (`files: dist, src`) but publishing is a deliberate post-v1 decision.
- Authentication / multi-tenant support.

## License

[MIT](./LICENSE)
