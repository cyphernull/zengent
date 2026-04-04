import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/create-agent.js";
import { createZengent } from "../src/app/create-zengent.js";
import { ConfigError } from "../src/core/errors.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createFakeModel } from "../src/testing/fake-model.js";
import { defineTool } from "../src/tool/define-tool.js";

describe("createZengent", () => {
  it("runs a registered flow and injects memory, events, and run history", async () => {
    const memory = createMemoryStore();
    const events: string[] = [];
    let capturedRunId: string | undefined;

    const weatherFetch = defineTool({
      name: "weatherFetch",
      description: "Get weather by city",
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

    const planAgent = createAgent({
      name: "planAgent",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
      instructions: "You are a travel planner.",
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "weatherFetch", input: { city: "Paris" } }],
        },
        {
          output: {
            summary: "Paris is sunny. Walk by the Seine.",
          },
        },
      ]),
      tools: [weatherFetch] as const,
    });

    const app = createZengent()
      .memory(memory)
      .onEvent(async (event) => {
        capturedRunId = capturedRunId ?? event.runId;
        events.push(event.type);
      });

    const tripFlow = app
      .flow({
        name: "tripFlow",
        inputSchema: z.object({
          city: z.string(),
        }),
        outputSchema: z.object({
          summary: z.string(),
          forecast: z.string(),
        }),
      })
      .agent("plan", planAgent)
      .process("shapeResult", {
        inputSchema: z.object({
          originalInput: z.object({
            city: z.string(),
          }),
          previous: z.object({
            summary: z.string(),
          }),
          results: z.object({
            plan: z.object({
              summary: z.string(),
            }),
          }),
        }),
        outputSchema: z.object({
          summary: z.string(),
          forecast: z.string(),
        }),
        run: async ({ input }) => ({
          summary: input.previous.summary,
          forecast: "sunny",
        }),
      })
      .finalize(({ results }) => results.shapeResult);

    const result = await app.runFlow(
      tripFlow,
      {
        city: "Paris",
      },
      {
        threadId: "trip-thread",
      }
    );

    expect(result.status).toBe("success");
    expect(events).toContain("run.started");
    expect(events).toContain("tool.completed");
    expect(events).toContain("flow.node.completed");

    const thread = await app.getThread("trip-thread");
    expect(thread?.messages.length).toBeGreaterThan(0);

    expect(capturedRunId).toBeDefined();
    expect(app.getRun(capturedRunId!)).toBeDefined();
    expect(app.getRun(capturedRunId!)?.target).toBe("tripFlow");
  });

  it("requires a known flow before running by name", async () => {
    const app = createZengent();

    await expect(app.runFlow("missing", {})).rejects.toThrowError(ConfigError);
  });
});
