import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createZengent } from "../src/app/create-zengent.js";
import { createFakeModel } from "../src/testing/fake-model.js";

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
});
