# ZenGent

ZenGent is a lightweight TypeScript-first agent framework organized around one app, one main workflow, and explicit execution boundaries.

It is designed to stay small, composable, and predictable:

- Define external capabilities as tools with explicit schemas.
- Create agents as reasoning units backed by model adapters.
- Build one `mainWorkflow` with inherited tools and agents.
- Run the application through `createZengent()`.

## Installation

```bash
npm install zengent zod
```

## Quickstart

```ts
import { z } from "zod";
import {
  createAgent,
  createMainWorkflow,
  createMemoryStore,
  createZengent,
  defineTool,
} from "zengent";
import { openaiAdapter } from "zengent/adapters/openai";

const weatherFetch = defineTool({
  name: "weatherFetch",
  description: "Get weather by city",
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, forecast: "sunny" }),
});

const planAgent = createAgent({
  name: "planAgent",
  instructions: "You are a concise travel planner.",
  model: openaiAdapter("gpt-4.1"),
  tools: [weatherFetch],
});

const tripWorkflow = createMainWorkflow({
  name: "tripWorkflow",
  input: z.object({ city: z.string() }),
  tools: [weatherFetch],
  agents: [planAgent],
})
  .step("plan", async ({ input, agents }) => {
    return agents.planAgent.run(`Plan a one day trip for ${input.city}`);
  })
  .commit();

const app = createZengent()
  .memory(createMemoryStore())
  .mainWorkflow(tripWorkflow);

const result = await app.run({ city: "Tokyo" }, { threadId: "trip-1" });
```

## Mental Model

ZenGent is built around one execution spine, not several competing runtime centers.

- `app`: the application entry and app-level state container
- `mainWorkflow`: the single top-level execution path
- `subWorkflow`: an internal reusable workflow owned by the main workflow
- `agent`: a reasoning execution unit used by workflow steps
- `tool`: an external capability unit
- `model adapter`: the model integration layer used by agents

That separation is intentional. ZenGent avoids designs where the app, multiple top-level workflows, routers, and free-floating agents all compete as architectural entry points. The workflow owns orchestration. Agents serve workflow steps instead of becoming the architecture themselves.

- One app
- One required `mainWorkflow`
- Zero or more `subWorkflow`
- Agents serve workflows
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
zengent/workflow
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
- One `mainWorkflow` per app
- `tool` is an external capability unit
- `agent` is a reasoning unit serving workflow steps
- `model adapter` is the model integration layer
- Tools and agents belong to the main workflow definition
- `subWorkflow` inherits the main workflow resource pool
- No required server, registry, or cloud coupling
