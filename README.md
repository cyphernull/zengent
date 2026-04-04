# zengent

zengent is a lightweight TypeScript-first agent framework organized around one app, direct agents, and explicit multi-agent flows.

It is designed to stay small, composable, and predictable:

- Define external capabilities as tools with explicit schemas.
- Create agents as the smallest reasoning unit.
- Build multi-agent flows with `agent`, `process`, `parallel`, and `finalize`.
- Run direct agents or whole flows through `createZengent()`.

## Installation

```bash
npm install zengent zod
```

## Quickstart

```ts
import { z } from "zod";
import { createZengent } from "zengent";
import { openaiAdapter } from "zengent/adapters/openai";

const app = createZengent();

const weatherFetch = app.tool({
  name: "weatherFetch",
  description: "Get weather by city",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    city: z.string(),
    forecast: z.string(),
  }),
  execute: async ({ city }) => ({
    city,
    forecast: "sunny",
  }),
});

// The tool's inputSchema is used both for local validation
// and for the model-side function/tool schema automatically.
// The agent's outputSchema also drives structured output automatically.

const planAgent = app.agent({
  name: "planAgent",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    itinerary: z.string(),
  }),
  instructions: "You are a concise travel planner.",
  prompt: ({ input }) => `Plan a one-day trip for ${input.city}.`,
  model: openaiAdapter("gpt-4.1"),
  tools: [weatherFetch],
});

const result = await planAgent.run({
  city: "Tokyo",
});
```

## Multi-Agent Flow

```ts
const marketAgent = app.agent({
  name: "marketAgent",
  inputSchema: z.object({
    symbol: z.string(),
    timeframe: z.string(),
  }),
  outputSchema: z.object({
    marketView: z.string(),
  }),
  model: openaiAdapter("gpt-4.1"),
});

const bullAgent = app.agent({
  name: "bullAgent",
  inputSchema: marketAgent.outputSchema,
  outputSchema: z.object({
    bullView: z.string(),
  }),
  instructions: "You are a bullish stock analyst. Focus on upside, momentum, catalysts, and positive signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bullish view based on these signals.
  `.trim(),
  model: openaiAdapter("gpt-4.1"),
});

const bearAgent = app.agent({
  name: "bearAgent",
  inputSchema: marketAgent.outputSchema,
  outputSchema: z.object({
    bearView: z.string(),
  }),
  instructions: "You are a bearish stock analyst. Focus on downside risks, weakness, and negative signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bearish view based on these signals.
  `.trim(),
  model: openaiAdapter("gpt-4.1"),
});

const managerAgent = app.agent({
  name: "managerAgent",
  inputSchema: z.object({
    symbol: z.string(),
    marketView: z.string(),
    bullView: z.string(),
    bearView: z.string(),
  }),
  outputSchema: z.object({
    recommendation: z.string(),
    confidence: z.number(),
  }),
  instructions: `
You are the final portfolio manager.

Your job is to weigh the market view, the bull case, and the bear case,
then make a clear investment recommendation.

Be balanced, decisive, and evidence-driven.
Do not simply restate both sides.
Resolve the disagreement and choose the dominant reasoning.

Return:
- recommendation: a concise action-oriented decision
- confidence: a number from 0 to 100 representing conviction
  `.trim(),
  prompt: ({ input }) => `
Original request:
${JSON.stringify({ symbol: input.symbol }, null, 2)}

Market view:
${input.marketView}

Bull case:
${input.bullView}

Bear case:
${input.bearView}

Make the final decision.
  `.trim(),
  model: openaiAdapter("gpt-4.1"),
});

const stockFlow = app.flow({
  name: "stockFlow",
  inputSchema: z.object({
    symbol: z.string(),
    timeframe: z.string(),
  }),
  outputSchema: managerAgent.outputSchema,
})
  .agent("market", marketAgent)
  .parallel("debate", {
    bull: bullAgent,
    bear: bearAgent,
  })
  .process("prepareDecision", {
    inputSchema: z.object({
      originalInput: z.object({
        symbol: z.string(),
        timeframe: z.string(),
      }),
      previous: z.object({
        bull: bullAgent.outputSchema,
        bear: bearAgent.outputSchema,
      }),
      results: z.object({
        market: marketAgent.outputSchema,
      }),
    }),
    outputSchema: managerAgent.inputSchema,
    run: async ({ input }) => ({
      symbol: input.originalInput.symbol,
      marketView: input.results.market.marketView,
      bullView: input.previous.bull.bullView,
      bearView: input.previous.bear.bearView,
    }),
  })
  .agent("manager", managerAgent)
  .finalize(({ results }) => results.manager);

const decision = await stockFlow.run({
  symbol: "AAPL",
  timeframe: "1M",
});
```

## Examples

This repository includes two runnable Express demos under `examples/`:

- `examples/travel-demo`: a single-agent travel planner with a local weather tool
- `examples/stock-demo`: a multi-agent stock analysis flow using `market`, `bull`, `bear`, and `manager`

These demos import the repository's local `src/` files directly, so they validate the current working tree instead of the published npm package.

To run one:

```bash
cd examples/travel-demo
npm install
cp .env.example .env
npm run dev
```

Both demos read `DEEPSEEK_API_KEY` from `.env`.

`outputSchema` is the only output contract you define for agents. zengent uses native provider structured output when available, and automatically falls back to JSON guidance plus local schema validation when a provider does not expose a native schema mode.

## Mental Model

zengent is built around one explicit execution spine.

- `app`: the required root object
- `agent`: the smallest reasoning execution unit
- `flow`: the multi-agent orchestration primitive
- `process`: a lightweight non-reasoning transform node inside a flow
- `tool`: an external capability unit
- `model adapter`: the model integration layer used by agents

That separation is intentional. Agents do the reasoning. Flows make coordination obvious. Processes handle the light data work between reasoning nodes.

When you want explicit model task text, use `instructions + prompt` together:

- `instructions`: fixed role and long-lived behavior
- `prompt({ input })`: this run's dynamic task content
- `inputSchema`: validates what the agent receives
- `outputSchema`: drives structured output and validates what the agent returns
- `tool.inputSchema`: also becomes the model-side tool parameter schema automatically

- One app
- Direct single-agent runs
- Explicit multi-agent flows
- Parallel is a built-in flow primitive
- Process nodes do not replace agents
- Tools are external capabilities, not model execution
- Model calls happen through `agent + model adapter`, not through tools

## Provider Adapters

Use a first-party adapter when you want a direct integration:

```ts
import { anthropicAdapter } from "zengent/adapters/anthropic";
import { geminiAdapter } from "zengent/adapters/gemini";
import { ollamaAdapter } from "zengent/adapters/ollama";
import { openRouterAdapter } from "zengent/adapters/openrouter";
import { openaiAdapter } from "zengent/adapters/openai";
```

Additional first-party adapters:

- `zengent/adapters/xai`
- `zengent/adapters/deepseek`
- `zengent/adapters/kimi`

Cloud adapters support both styles:

```ts
const model = openaiAdapter("gpt-4.1");
```

This form reads the API key from the provider environment variable at request time.

```ts
const model = openaiAdapter({
  model: "gpt-4.1",
  apiKey: process.env.OPENAI_API_KEY,
});
```

If both are present, the explicit `apiKey` wins over the environment variable.

Provider environment variables:

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- Gemini: `GOOGLE_GENERATIVE_AI_API_KEY`
- OpenRouter: `OPENROUTER_API_KEY`
- DeepSeek: `DEEPSEEK_API_KEY`
- xAI: `XAI_API_KEY`
- Kimi / Moonshot: `MOONSHOT_API_KEY`

Ollama remains local-first and does not require an API key.

## Package Structure

```text
zengent
zengent/agent
zengent/flow
zengent/tool
zengent/adapters/openai
zengent/adapters/anthropic
zengent/adapters/gemini
zengent/adapters/xai
zengent/adapters/openrouter
zengent/adapters/deepseek
zengent/adapters/kimi
zengent/adapters/ollama
zengent/integrations/mcp
zengent/testing
```

## MCP Integration

Use `zengent/integrations/mcp` when you already have an MCP client and want to turn its tools into zengent tools.

This is a tool integration layer, not an MCP runtime. zengent does not currently manage MCP transport, auth, sessions, or server lifecycle.

Wrap a single MCP tool explicitly:

```ts
import { z } from "zod";
import { createMcpTool } from "zengent/integrations/mcp";

const weather = createMcpTool({
  client: mcpClient,
  name: "weather",
  description: "Get weather by city",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    forecast: z.string(),
  }),
});
```

Discover MCP tools from a client that supports `listTools()`:

```ts
import { discoverMcpTools } from "zengent/integrations/mcp";

const discoveredTools = await discoverMcpTools({
  client: mcpClient,
  include: ["weather", "news"],
});
```

## Design Notes

- Node-first, in-process runtime
- One required `app` root
- `tool` is an external capability unit
- `agent` is the smallest reasoning unit
- `flow` is the multi-agent orchestration primitive
- `process` is a lightweight transform node
- `model adapter` is the model integration layer
- No required server, registry, or cloud coupling
