import { z } from "zod";

import {
  createAgent,
  createZengent,
  defineTool,
} from "../src/index.js";
import { anthropicAdapter } from "../src/adapters/anthropic.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { createMcpTool, discoverMcpTools } from "../src/integrations/mcp.js";
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
  prompt: ({ input }) => `Plan a trip for ${input.city}`,
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
  instructions:
    "You are a bullish stock analyst. Focus on upside, momentum, catalysts, and positive signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bullish view based on these signals.
  `.trim(),
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
  instructions:
    "You are a bearish stock analyst. Focus on downside risks, weakness, and negative signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bearish view based on these signals.
  `.trim(),
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
  prompt: ({ input }) =>
    [
      `Symbol: ${input.symbol}`,
      `Market view: ${input.marketView}`,
      `Bull case: ${input.bullView}`,
      `Bear case: ${input.bearView}`,
      "Make the final decision.",
    ].join("\n"),
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

const mcpTool = createMcpTool({
  client: {
    async callTool() {
      return {
        content: {
          forecast: "sunny",
        },
      };
    },
  },
  name: "weather",
  description: "Get weather",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    forecast: z.string(),
  }),
});

async function mcpTypes() {
  const result = await mcpTool.invoke({ city: "Tokyo" }, {
    runId: "run",
    metadata: {},
    now: () => new Date(),
    emit: async () => {},
    child: () => {
      throw new Error("unused");
    },
    nextId: () => "id",
  });

  const forecast: string = result.forecast;
  void forecast;

  const tools = await discoverMcpTools({
    client: {
      async callTool() {
        return {
          content: {},
        };
      },
      async listTools() {
        return [{ name: "weather" }];
      },
    },
  });

  const names: string[] = tools.map((tool) => tool.name);
  void names;
}

void mcpTypes;

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
