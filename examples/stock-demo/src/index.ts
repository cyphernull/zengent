import "dotenv/config";

import express from "express";
import { z } from "zod";
import { createZengent } from "../../../src/index.js";
import { deepseekAdapter } from "../../../src/adapters/deepseek.js";

const port = Number(process.env.PORT ?? 3002);
const runtime = createZengent();

const marketAgent = runtime.agent({
  name: "marketAgent",
  inputSchema: z.object({
    symbol: z.string(),
    timeframe: z.string(),
  }),
  outputSchema: z.object({
    marketView: z.string(),
  }),
  instructions: `
You are a market analyst.

Summarize the market setup for the given stock and timeframe in a concise way.
  `.trim(),
  prompt: ({ input }) =>
    `Analyze the market setup for ${input.symbol} on the ${input.timeframe} timeframe.`,
  model: deepseekAdapter("deepseek-chat"),
});

const bullAgent = runtime.agent({
  name: "bullAgent",
  inputSchema: marketAgent.outputSchema,
  outputSchema: z.object({
    bullView: z.string(),
  }),
  instructions:
    "You are a bullish stock analyst. Focus on upside, momentum, catalysts, and positive signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bullish view based on these signals.
  `.trim(),
  model: deepseekAdapter("deepseek-chat"),
});

const bearAgent = runtime.agent({
  name: "bearAgent",
  inputSchema: marketAgent.outputSchema,
  outputSchema: z.object({
    bearView: z.string(),
  }),
  instructions:
    "You are a bearish stock analyst. Focus on downside risks, weakness, and negative signals only.",
  prompt: ({ input }) => `
Here is the market analysis:

${JSON.stringify(input, null, 2)}

Write a concise bearish view based on these signals.
  `.trim(),
  model: deepseekAdapter("deepseek-chat"),
});

const managerAgent = runtime.agent({
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
  prompt: ({ input }) =>
    [
      `Symbol: ${input.symbol}`,
      `Market view: ${input.marketView}`,
      `Bull case: ${input.bullView}`,
      `Bear case: ${input.bearView}`,
      "Make the final decision.",
    ].join("\n"),
  model: deepseekAdapter("deepseek-chat"),
});

const stockFlow = runtime
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

const server = express();
server.use(express.json());

server.get("/health", (_req, res) => {
  res.json({
    ok: true,
    demo: "stock-demo",
  });
});

server.post("/analyze-stock", async (req, res) => {
  const result = await stockFlow.run(req.body);

  if (result.status !== "success") {
    res.status(400).json({
      status: result.status,
      error: result.error.message,
      toolTraces: result.toolTraces,
      steps: result.steps,
    });
    return;
  }

  res.json({
    status: result.status,
    output: result.output,
    steps: result.steps,
  });
});

server.listen(port, () => {
  console.log(`stock-demo listening on http://localhost:${port}`);
});
