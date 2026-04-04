import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createZengent } from "../src/app/create-zengent.js";
import { createFakeModel, createFakeStreamingModel } from "../src/testing/fake-model.js";

describe("flow", () => {
  it("runs a sequential and parallel pipeline with a process node", async () => {
    const app = createZengent();

    const marketAgent = app.agent({
      name: "marketAgent",
      inputSchema: z.object({
        symbol: z.string(),
        timeframe: z.string(),
      }),
      outputSchema: z.object({
        marketView: z.string(),
      }),
      model: createFakeModel([
        {
          output: {
            marketView: "Momentum is positive.",
          },
        },
      ]),
    });

    const bullAgent = app.agent({
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
      model: createFakeModel([
        {
          output: {
            bullView: "Upside remains attractive.",
          },
        },
      ]),
    });

    const bearAgent = app.agent({
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
      model: createFakeModel([
        {
          output: {
            bearView: "Valuation is stretched.",
          },
        },
      ]),
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
            recommendation: "Buy on pullbacks.",
            confidence: 82,
          },
        },
      ]),
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

    const result = await stockFlow.run({
      symbol: "AAPL",
      timeframe: "1M",
    });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    expect(result.output.recommendation).toBe("Buy on pullbacks.");
    expect(result.output.confidence).toBe(82);
  });

  it("validates process input against the flow context envelope", async () => {
    const app = createZengent();

    const textAgent = app.agent({
      name: "textAgent",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
      model: createFakeModel([
        {
          output: {
            summary: "ok",
          },
        },
      ]),
    });

    const flow = app.flow({
      name: "badProcessFlow",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
    })
      .agent("market", textAgent)
      .process("broken", {
        inputSchema: z.object({
          originalInput: z.object({
            missing: z.string(),
          }),
        }),
        outputSchema: z.object({
          summary: z.string(),
        }),
        run: async () => ({
          summary: "never",
        }),
      })
      .finalize(({ results }) => ({
        summary: String(results.broken),
      }));

    const result = await flow.run({
      symbol: "AAPL",
    });

    expect(result.status).toBe("failed");
  });

  it("rejects invalid finalize output", async () => {
    const app = createZengent();
    const agent = app.agent({
      name: "simple",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
      model: createFakeModel([
        {
          output: {
            summary: "done",
          },
        },
      ]),
    });

    const flow = app.flow({
      name: "finalizeFlow",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        count: z.number(),
      }),
    })
      .agent("summary", agent)
      .finalize(() => ({
        count: "bad",
      }));

    const result = await flow.run({
      city: "Tokyo",
    });

    expect(result.status).toBe("failed");
  });

  it("streams chunks from sequential agent nodes", async () => {
    const app = createZengent();

    const marketAgent = app.agent({
      name: "marketAgent",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: z.object({
        marketView: z.string(),
      }),
      model: createFakeStreamingModel([
        {
          chunks: ["market ", "ready"],
          response: {
            output: {
              marketView: "market ready",
            },
          },
        },
      ]),
    });

    const managerAgent = app.agent({
      name: "managerAgent",
      inputSchema: marketAgent.outputSchema,
      outputSchema: z.object({
        recommendation: z.string(),
      }),
      model: createFakeStreamingModel([
        {
          chunks: ["buy ", "now"],
          response: {
            output: {
              recommendation: "buy now",
            },
          },
        },
      ]),
    });

    const flow = app.flow({
      name: "streamingFlow",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: managerAgent.outputSchema,
    })
      .agent("market", marketAgent)
      .agent("manager", managerAgent)
      .finalize(({ results }) => results.manager);

    const chunks: Array<{ node: string; text: string }> = [];
    const stream = flow.stream({
      symbol: "AAPL",
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const result = await stream.result;

    expect(chunks).toEqual([
      { node: "market", text: "market " },
      { node: "market", text: "ready" },
      { node: "manager", text: "buy " },
      { node: "manager", text: "now" },
    ]);
    expect(result.status).toBe("success");
  });

  it("streams tagged chunks from parallel agent nodes", async () => {
    const app = createZengent();

    const marketAgent = app.agent({
      name: "marketAgent",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: z.object({
        marketView: z.string(),
      }),
      model: createFakeModel([
        {
          output: {
            marketView: "stable",
          },
        },
      ]),
    });

    const bullAgent = app.agent({
      name: "bullAgent",
      inputSchema: marketAgent.outputSchema,
      outputSchema: z.object({
        bullView: z.string(),
      }),
      model: createFakeStreamingModel([
        {
          chunks: ["bull-1", "bull-2"],
          response: {
            output: {
              bullView: "bull complete",
            },
          },
        },
      ]),
    });

    const bearAgent = app.agent({
      name: "bearAgent",
      inputSchema: marketAgent.outputSchema,
      outputSchema: z.object({
        bearView: z.string(),
      }),
      model: createFakeStreamingModel([
        {
          chunks: ["bear-1", "bear-2"],
          response: {
            output: {
              bearView: "bear complete",
            },
          },
        },
      ]),
    });

    const managerAgent = app.agent({
      name: "managerAgent",
      inputSchema: z.object({
        bullView: z.string(),
        bearView: z.string(),
      }),
      outputSchema: z.object({
        recommendation: z.string(),
      }),
      model: createFakeModel([
        {
          output: {
            recommendation: "hold",
          },
        },
      ]),
    });

    const flow = app.flow({
      name: "parallelStreamingFlow",
      inputSchema: z.object({
        symbol: z.string(),
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
          bullView: input.previous.bull.bullView,
          bearView: input.previous.bear.bearView,
        }),
      })
      .agent("manager", managerAgent)
      .finalize(({ results }) => results.manager);

    const chunks: Array<{ node: string; text: string }> = [];
    const stream = flow.stream({
      symbol: "AAPL",
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const result = await stream.result;

    expect(chunks).toEqual(
      expect.arrayContaining([
        { node: "bull", text: "bull-1" },
        { node: "bull", text: "bull-2" },
        { node: "bear", text: "bear-1" },
        { node: "bear", text: "bear-2" },
      ])
    );
    expect(result.status).toBe("success");
  });
});
