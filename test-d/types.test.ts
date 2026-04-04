import { z } from "zod";

import {
  createAgent,
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
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    city: z.string(),
    forecast: z.literal("sunny"),
  }),
  execute: async ({ city }) => ({
    city,
    forecast: "sunny" as const,
  }),
});

const planner = createAgent({
  name: "planner",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    summary: z.string(),
  }),
  model: createFakeModel([
    {
      output: {
        ok: true,
        summary: "done",
      },
    },
  ]),
  tools: [weather] as const,
});

async function agentTypes() {
  const result = await planner.run({ city: "Tokyo" });

  if (result.status !== "success") {
    return;
  }

  const ok: boolean = result.output.ok;
  const summary: string = result.output.summary;
  void ok;
  void summary;
}

void agentTypes;

const app = createZengent();

const marketInputSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
});

const marketOutputSchema = z.object({
  marketView: z.string(),
  score: z.number(),
});

const bullOutputSchema = z.object({
  bullView: z.string(),
});

const bearOutputSchema = z.object({
  bearView: z.string(),
});

const managerInputSchema = z.object({
  symbol: z.string(),
  marketView: z.string(),
  bullView: z.string(),
  bearView: z.string(),
});

const managerOutputSchema = z.object({
  recommendation: z.string(),
  confidence: z.number(),
});

const marketAgent = app.agent({
  name: "marketAgent",
  inputSchema: marketInputSchema,
  outputSchema: marketOutputSchema,
  model: createFakeModel([
    {
      output: {
        marketView: "trend is stable",
        score: 0.7,
      },
    },
  ]),
});

const bullAgent = app.agent({
  name: "bullAgent",
  inputSchema: marketOutputSchema,
  outputSchema: bullOutputSchema,
  model: createFakeModel([
    {
      output: {
        bullView: "upside remains strong",
      },
    },
  ]),
});

const bearAgent = app.agent({
  name: "bearAgent",
  inputSchema: marketOutputSchema,
  outputSchema: bearOutputSchema,
  model: createFakeModel([
    {
      output: {
        bearView: "macro risk is elevated",
      },
    },
  ]),
});

const managerAgent = app.agent({
  name: "managerAgent",
  inputSchema: managerInputSchema,
  outputSchema: managerOutputSchema,
  model: createFakeModel([
    {
      output: {
        recommendation: "hold",
        confidence: 0.75,
      },
    },
  ]),
});

const stockFlow = app
  .flow({
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
        bull: bullOutputSchema,
        bear: bearOutputSchema,
      }),
      results: z.object({
        market: marketOutputSchema,
        debate: z.object({
          bull: bullOutputSchema,
          bear: bearOutputSchema,
        }),
      }),
    }),
    outputSchema: managerInputSchema,
    run: async ({ input }) => ({
      symbol: input.originalInput.symbol,
      marketView: input.results.market.marketView,
      bullView: input.results.debate.bull.bullView,
      bearView: input.results.debate.bear.bearView,
    }),
  })
  .agent("manager", managerAgent)
  .finalize(({ results }) => results.manager);

async function flowTypes() {
  const result = await stockFlow.run({
    symbol: "AAPL",
    timeframe: "1d",
  });

  if (result.status !== "success") {
    return;
  }

  const recommendation: string = result.output.recommendation;
  const confidence: number = result.output.confidence;
  void recommendation;
  void confidence;
}

void flowTypes;

const providerAdapters = [
  anthropicAdapter({
    model: "claude-test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "{\"value\":\"anthropic\"}" }],
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
          candidates: [{ content: { parts: [{ text: "{\"value\":\"gemini\"}" }] } }],
        }),
        { status: 200 }
      ),
  }),
  openRouterAdapter({
    model: "openai/gpt-4.1",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"value\":\"router\"}" } }],
        }),
        { status: 200 }
      ),
  }),
  ollamaAdapter({
    model: "qwen3:latest",
    fetch: async () =>
      new Response(
        JSON.stringify({
          message: { content: "{\"value\":\"ollama\"}" },
        }),
        { status: 200 }
      ),
  }),
];

for (const model of providerAdapters) {
  const agent = createAgent({
    name: model.name,
    inputSchema: z.object({
      query: z.string(),
    }),
    outputSchema: z.object({
      value: z.string(),
    }),
    model,
  });

  void agent;
}
