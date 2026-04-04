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

const planAgent = app.agent({
  name: "planAgent",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    itinerary: z.string(),
  }),
  instructions: "You are a concise travel planner.",
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
  model: openaiAdapter("gpt-4.1"),
});

const bearAgent = app.agent({
  name: "bearAgent",
  inputSchema: marketAgent.outputSchema,
  outputSchema: z.object({
    bearView: z.string(),
  }),
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

## Mental Model

zengent is built around one explicit execution spine.

- `app`: the required root object
- `agent`: the smallest reasoning execution unit
- `flow`: the multi-agent orchestration primitive
- `process`: a lightweight non-reasoning transform node inside a flow
- `tool`: an external capability unit
- `model adapter`: the model integration layer used by agents

That separation is intentional. Agents do the reasoning. Flows make coordination obvious. Processes handle the light data work between reasoning nodes.

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

## Bring Your Own Model Layer

Use `aiSdkAdapter()` if you already have a model object from an AI SDK:

```ts
import { aiSdkAdapter } from "zengent/adapters/ai-sdk";

const model = aiSdkAdapter(existingSdkModel, {
  name: "my-ai-sdk-model",
});
```

Use `createModelAdapter()` if you want full control over HTTP or a custom backend:

```ts
import { createModelAdapter } from "zengent";

const model = createModelAdapter({
  name: "internal-model",
  async generate() {
    return {
      text: "hello from a custom adapter",
    };
  },
});
```

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
zengent/adapters/ai-sdk
zengent/adapters/mcp
zengent/testing
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
