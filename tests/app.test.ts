import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/create-agent.js";
import { createZengent } from "../src/app/create-zengent.js";
import { ConfigError } from "../src/core/errors.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createFakeModel } from "../src/testing/fake-model.js";
import { defineTool } from "../src/tool/define-tool.js";
import { createMainWorkflow } from "../src/workflow/create-main-workflow.js";

describe("createZengent", () => {
  it("runs the configured main workflow and injects memory, events, and run history", async () => {
    const memory = createMemoryStore();
    const events: string[] = [];
    let capturedRunId: string | undefined;

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
      instructions: "You are a travel planner.",
      model: createFakeModel([
        {
          toolCalls: [{ id: "call_1", name: "weatherFetch", input: { city: "Paris" } }],
        },
        {
          text: "Paris is sunny. Walk by the Seine.",
        },
      ]),
      tools: [weatherFetch] as const,
    });

    const tripWorkflow = createMainWorkflow({
      name: "tripWorkflow",
      input: z.object({
        city: z.string(),
      }),
      agents: [planAgent] as const,
      tools: [weatherFetch] as const,
    })
      .step("plan", async ({ input, agents }) => {
        return agents.planAgent.run(`Plan a trip for ${input.city}`);
      })
      .commit();

    const app = createZengent()
      .memory(memory)
      .onEvent(async (event) => {
        capturedRunId = capturedRunId ?? event.runId;
        events.push(event.type);
      })
      .mainWorkflow(tripWorkflow);

    const result = await app.run(
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

    const thread = await app.getThread("trip-thread");
    expect(thread?.messages.length).toBeGreaterThan(0);

    expect(capturedRunId).toBeDefined();
    expect(app.getRun(capturedRunId!)).toBeDefined();
    expect(app.getRun(capturedRunId!)?.target).toBe("tripWorkflow");
  });

  it("requires a main workflow before running", async () => {
    const app = createZengent();

    await expect(app.run(undefined as never)).rejects.toThrowError(ConfigError);
  });
});
