import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/create-agent.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { defineTool } from "../src/tool/define-tool.js";
import { createFakeModel } from "../src/testing/fake-model.js";

describe("agent", () => {
  it("runs a tool loop and persists thread messages", async () => {
    const memory = createMemoryStore();
    const weather = defineTool({
      name: "weather",
      description: "Get the weather",
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny",
      }),
    });

    const agent = createAgent({
      name: "planner",
      instructions: "You are a travel planner.",
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "weather", input: { city: "Paris" } }],
        },
        {
          text: "Paris is sunny. Walk by the Seine and visit the Louvre.",
        },
      ]),
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

    const thread = await memory.getThread("trip-thread");
    expect(thread?.messages).toHaveLength(4);
  });

  it("surfaces schema failures as explicit tool errors", async () => {
    const weather = defineTool({
      name: "weather",
      description: "Get the weather",
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny",
      }),
    });

    const agent = createAgent({
      name: "planner",
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
    let attempts = 0;

    const flaky = defineTool({
      name: "flaky",
      description: "Fails once",
      input: z.object({ task: z.string() }),
      execute: async ({ task }) => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("temporary failure");
        }

        return { task, ok: true };
      },
    });

    const agent = createAgent({
      name: "worker",
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

  it("fails slow tools with a timeout", async () => {
    const slow = defineTool({
      name: "slow",
      description: "Takes too long",
      input: z.object({ task: z.string() }),
      execute: async () =>
        await new Promise((resolve) => {
          setTimeout(() => resolve("late"), 30);
        }),
    });

    const agent = createAgent({
      name: "worker",
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "slow", input: { task: "demo" } }],
        },
      ]),
      tools: [slow],
      toolPolicy: {
        timeoutMs: 5,
      },
    });

    const result = await agent.run("Run it");

    expect(result.status).toBe("failed");

    if (result.status !== "failed") {
      return;
    }

    expect(result.error.message).toContain('Tool "slow" failed');
  });

  it("streams events and resolves the same final result shape as run", async () => {
    const buildAgent = () =>
      createAgent({
        name: "assistant",
        model: createFakeModel([
          {
            text: "hello",
          },
        ]),
      });

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
});
