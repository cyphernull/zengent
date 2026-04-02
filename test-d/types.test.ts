import { z } from "zod";

import {
  createAgent,
  createMainWorkflow,
  createZengent,
  defineTool,
} from "../src/index.js";
import { anthropicAdapter } from "../src/adapters/anthropic.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { ollamaAdapter } from "../src/adapters/ollama.js";
import { openRouterAdapter } from "../src/adapters/openrouter.js";
import { createFakeModel } from "../src/testing/index.js";

const weather = defineTool({
  name: "weather",
  description: "Weather lookup",
  input: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => ({
    city,
    forecast: "sunny" as const,
  }),
});

const planner = createAgent({
  name: "planner",
  model: createFakeModel([
    {
      text: "{\"ok\":true,\"summary\":\"done\"}",
    },
  ]),
  tools: [weather] as const,
  output: z.object({
    ok: z.boolean(),
    summary: z.string(),
  }),
});

async function agentTypes() {
  const result = await planner.run("Hello");

  if (result.status !== "success") {
    return;
  }

  const ok: boolean = result.output.ok;
  const summary: string = result.output.summary;
  void ok;
  void summary;
}

const tripWorkflow = createMainWorkflow({
  name: "trip-workflow",
  input: z.object({
    city: z.string(),
  }),
})
  .step("city", async ({ input }) => input.city)
  .step("count", async ({ steps }) => steps.city.length)
  .commit();

async function mainWorkflowTypes() {
  const result = await tripWorkflow.run({
    city: "Tokyo",
  });

  if (result.status !== "success") {
    return;
  }

  const city: string = result.output.city;
  const count: number = result.output.count;
  void city;
  void count;
}

void agentTypes;
void mainWorkflowTypes;

const appWorkflow = createMainWorkflow({
  name: "appWorkflow",
  input: z.object({
    city: z.string(),
  }),
  tools: [weather] as const,
  agents: [planner] as const,
})
  .step("quote", async ({ input, tools, ctx }) => {
    return tools.weather.invoke({ city: input.city }, ctx);
  })
  .step("plan", async ({ input, agents }) => {
    return agents.planner.run(`Plan a trip for ${input.city}`);
  })
  .commit();

const app = createZengent().mainWorkflow(appWorkflow);

async function appTypes() {
  const result = await app.run({
    city: "Tokyo",
  });

  if (result.status !== "success") {
    return;
  }

  const forecast: string = result.output.quote.forecast;
  void forecast;
}

void appTypes;

const providerAdapters = [
  anthropicAdapter({
    model: "claude-test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "anthropic" }],
          stop_reason: "end_turn",
        }),
        { status: 200 }
      ),
  }),
  geminiAdapter({
    model: "gemini-test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "gemini" }] } }],
        }),
        { status: 200 }
      ),
  }),
  openRouterAdapter({
    model: "openai/gpt-4.1",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "router" } }],
        }),
        { status: 200 }
      ),
  }),
  ollamaAdapter({
    model: "qwen3:latest",
    fetch: async () =>
      new Response(
        JSON.stringify({
          message: { content: "ollama" },
        }),
        { status: 200 }
      ),
  }),
];

for (const model of providerAdapters) {
  const agent = createAgent({
    name: model.name,
    model,
  });

  void agent;
}
