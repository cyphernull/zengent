import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/create-agent.js";
import { ConfigError } from "../src/core/errors.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createFakeModel } from "../src/testing/fake-model.js";
import { defineTool } from "../src/tool/define-tool.js";
import { createMainWorkflow } from "../src/workflow/create-main-workflow.js";
import { pause } from "../src/workflow/step.js";

describe("main workflow", () => {
  it("exposes tools and agents on the step context", async () => {
    const stockFetch = defineTool({
      name: "stockFetch",
      description: "Get stock quotes",
      input: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => ({
        symbol,
        price: 180,
      }),
    });

    const planAgent = createAgent({
      name: "planAgent",
      model: createFakeModel([{ text: "Use the stock quote in the plan." }]),
    });

    const tripWorkflow = createMainWorkflow({
      name: "tripWorkflow",
      input: z.object({
        symbol: z.string(),
      }),
      tools: [stockFetch] as const,
      agents: [planAgent] as const,
    })
      .step("quote", async ({ input, tools, ctx }) => {
        return tools.stockFetch.invoke({ symbol: input.symbol }, ctx);
      })
      .step("plan", async ({ agents, steps }) => {
        const result = await agents.planAgent.run(
          `Plan around price ${steps.quote.price}`
        );

        if (result.status !== "success") {
          throw result.error;
        }

        return result.output;
      })
      .commit();

    const result = await tripWorkflow.run({ symbol: "AAPL" });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    expect(result.output.quote.price).toBe(180);
    expect(result.output.plan).toBe("Use the stock quote in the plan.");
  });

  it("creates subworkflows that inherit tools and agents", async () => {
    const weatherFetch = defineTool({
      name: "weatherFetch",
      description: "Get weather by city",
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny",
      }),
    });

    const planAgent = createAgent({
      name: "planAgent",
      model: createFakeModel([{ text: "Pack sunscreen." }]),
    });

    const tripWorkflow = createMainWorkflow({
      name: "tripWorkflow",
      input: z.object({
        city: z.string(),
      }),
      tools: [weatherFetch] as const,
      agents: [planAgent] as const,
    });

    const budgetWorkflow = tripWorkflow
      .createSubWorkflow({
        name: "budgetWorkflow",
        input: z.object({
          city: z.string(),
        }),
      })
      .step("weather", async ({ input, tools, ctx }) => {
        return tools.weatherFetch.invoke({ city: input.city }, ctx);
      })
      .step("packing", async ({ agents }) => {
        const result = await agents.planAgent.run("What should I pack?");

        if (result.status !== "success") {
          throw result.error;
        }

        return result.output;
      })
      .commit();

    tripWorkflow
      .step("budget", async ({ input }) => {
        return budgetWorkflow.run({ city: input.city });
      })
      .commit();

    const result = await tripWorkflow.run({ city: "Tokyo" });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    const budgetResult = result.output.budget;
    expect(budgetResult.status).toBe("success");

    if (budgetResult.status !== "success") {
      return;
    }

    expect(budgetResult.output.weather.forecast).toBe("sunny");
    expect(budgetResult.output.packing).toBe("Pack sunscreen.");
  });

  it("fails fast on duplicate tool or agent names", () => {
    const firstTool = defineTool({
      name: "shared",
      description: "First",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
    });
    const secondTool = defineTool({
      name: "shared",
      description: "Second",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
    });

    expect(() =>
      createMainWorkflow({
        name: "badWorkflow",
        input: z.object({ value: z.string() }),
        tools: [firstTool, secondTool] as const,
      })
    ).toThrowError(ConfigError);

    const firstAgent = createAgent({
      name: "sharedAgent",
      model: createFakeModel([{ text: "one" }]),
    });
    const secondAgent = createAgent({
      name: "sharedAgent",
      model: createFakeModel([{ text: "two" }]),
    });

    expect(() =>
      createMainWorkflow({
        name: "badAgentsWorkflow",
        input: z.object({ value: z.string() }),
        agents: [firstAgent, secondAgent] as const,
      })
    ).toThrowError(ConfigError);
  });

  it("supports pause in subworkflows", async () => {
    const main = createMainWorkflow({
      name: "main",
      input: z.object({
        ticketId: z.string(),
      }),
    });

    const review = main
      .createSubWorkflow({
        name: "review",
        input: z.object({
          ticketId: z.string(),
        }),
      })
      .step("gate", async ({ input }) => {
        return pause({ ticketId: input.ticketId }, "Need approval");
      })
      .commit();

    main
      .step("review", async ({ input }) => {
        return review.run({ ticketId: input.ticketId });
      })
      .commit();

    const result = await main.run({ ticketId: "T-100" });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    expect(result.output.review.status).toBe("paused");
  });
});
