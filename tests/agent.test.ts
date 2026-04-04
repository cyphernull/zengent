import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createZengent } from "../src/app/create-zengent.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createFakeModel } from "../src/testing/fake-model.js";

describe("agent", () => {
  it("runs a tool loop and persists thread messages", async () => {
    const app = createZengent();
    const memory = createMemoryStore();
    const model = createFakeModel([
      {
        toolCalls: [{ id: "call_1", name: "weather", input: { city: "Paris" } }],
      },
      {
        text: "Paris is sunny. Walk by the Seine and visit the Louvre.",
      },
    ]);

    const weather = app.tool({
      name: "weather",
      description: "Get the weather",
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({
        city: z.string(),
        forecast: z.string(),
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny",
      }),
    });

    const agent = app.agent({
      name: "planner",
      inputSchema: z.string(),
      outputSchema: z.string(),
      instructions: "You are a travel planner.",
      model,
      tools: [weather],
      memory,
    });

    const result = await agent.run("Plan Paris", {
      threadId: "trip-thread",
    });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    expect(result.output).toContain("Paris is sunny");
    expect(result.toolTraces).toHaveLength(1);
    expect(result.toolTraces[0]?.output).toEqual({
      city: "Paris",
      forecast: "sunny",
    });
    expect(model.calls[0]?.tools?.[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        city: {
          type: "string",
        },
      },
      required: ["city"],
    });

    const thread = await memory.getThread("trip-thread");
    expect(thread?.messages).toHaveLength(4);
  });

  it("surfaces schema failures as explicit tool errors", async () => {
    const app = createZengent();

    const weather = app.tool({
      name: "weather",
      description: "Get the weather",
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({
        city: z.string(),
        forecast: z.string(),
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny",
      }),
    });

    const agent = app.agent({
      name: "planner",
      inputSchema: z.string(),
      outputSchema: z.string(),
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "weather", input: {} }],
        },
      ]),
      tools: [weather],
    });

    const result = await agent.run("Plan Paris");

    expect(result.status).toBe("failed");

    if (result.status !== "failed") {
      return;
    }

    expect(result.error.message).toContain('Tool "weather" failed');
    expect(result.toolTraces[0]?.error).toContain('Invalid input for tool "weather"');
  });

  it("retries flaky tools before succeeding", async () => {
    const app = createZengent();
    let attempts = 0;

    const flaky = app.tool({
      name: "flaky",
      description: "Fails once",
      inputSchema: z.object({ task: z.string() }),
      outputSchema: z.object({
        task: z.string(),
        ok: z.boolean(),
      }),
      execute: async ({ task }) => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("temporary failure");
        }

        return { task, ok: true };
      },
    });

    const agent = app.agent({
      name: "worker",
      inputSchema: z.string(),
      outputSchema: z.string(),
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "flaky", input: { task: "demo" } }],
        },
        {
          text: "done",
        },
      ]),
      tools: [flaky],
      toolPolicy: {
        retries: 1,
      },
    });

    const result = await agent.run("Run it");

    expect(result.status).toBe("success");
    expect(attempts).toBe(2);
    expect(result.toolTraces).toHaveLength(2);
  });

  it("fails invalid agent input before model execution", async () => {
    const app = createZengent();

    const agent = app.agent({
      name: "typed",
      inputSchema: z.object({
        symbol: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
      model: createFakeModel(),
    });

    const result = await agent.run({} as never);

    expect(result.status).toBe("failed");

    if (result.status !== "failed") {
      return;
    }

    expect(result.error.message).toContain('Invalid input for agent "typed"');
  });

  it("streams events and resolves the same final result shape as run", async () => {
    const buildAgent = () => {
      const app = createZengent();
      return app.agent({
        name: "assistant",
        inputSchema: z.string(),
        outputSchema: z.string(),
        model: createFakeModel([
          {
            text: "hello",
          },
        ]),
      });
    };

    const streamedEvents: string[] = [];
    const stream = buildAgent().stream("Hi");

    for await (const event of stream) {
      streamedEvents.push(event.type);
    }

    const streamedResult = await stream.result;
    const directResult = await buildAgent().run("Hi");

    expect(streamedEvents).toContain("run.started");
    expect(streamedEvents).toContain("model.completed");
    expect(streamedResult).toEqual(directResult);
  });

  it("uses prompt output as the user message while keeping instructions intact", async () => {
    const app = createZengent();
    const model = createFakeModel([
      {
        text: "bearish summary",
      },
    ]);

    const agent = app.agent({
      name: "bearAgent",
      inputSchema: z.object({
        marketView: z.string(),
      }),
      outputSchema: z.string(),
      instructions: "You are a bearish stock analyst.",
      prompt: ({ input }) => `Here is the market data:\n${input.marketView}`,
      model,
    });

    const result = await agent.run({
      marketView: "Momentum is weakening.",
    });

    expect(result.status).toBe("success");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.instructions).toBe("You are a bearish stock analyst.");
    expect(model.calls[0]?.messages[0]).toEqual({
      role: "user",
      content: "Here is the market data:\nMomentum is weakening.",
    });
    expect(model.calls[0]?.messages).toEqual(
      expect.arrayContaining([
        {
          role: "user",
          content: "Here is the market data:\nMomentum is weakening.",
        },
      ])
    );
  });
});
