import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/create-agent.js";
import { createFakeModel } from "../src/testing/fake-model.js";
import { createMainWorkflow } from "../src/workflow/create-main-workflow.js";
import { pause } from "../src/workflow/step.js";

describe("control flow", () => {
  it("executes sequential, parallel, branch, and explicit agent steps", async () => {
    const researcher = createAgent({
      name: "researcher",
      model: createFakeModel([{ text: "research notes" }]),
    });

    const writer = createAgent({
      name: "writer",
      model: createFakeModel([{ text: "final draft" }]),
    });

    const workflow = createMainWorkflow({
      name: "content-flow",
      input: z.object({
        topic: z.string(),
        fast: z.boolean(),
      }),
      agents: [researcher, writer] as const,
    })
      .step("research", async ({ input, parallel }) => {
        return parallel({
          notes: async () => `notes:${input.topic}`,
          citations: async () => [`source:${input.topic}`],
        });
      })
      .step("path", async ({ input, branch }) => {
        return branch(input.fast ? "quick" : "deep", {
          quick: async () => "quick",
          deep: async () => "deep",
        });
      })
      .step("draft", async ({ input, steps, agents }) => {
        const target =
          steps.path === "quick" ? agents.writer : agents.researcher;
        const result = await target.run(`Create output for ${input.topic}`);

        if (result.status !== "success") {
          throw result.error;
        }

        return {
          mode: steps.path,
          notes: steps.research.notes,
          draft: result.output,
        };
      })
      .commit();

    const result = await workflow.run({
      topic: "TypeScript agents",
      fast: true,
    });

    expect(result.status).toBe("success");

    if (result.status !== "success") {
      return;
    }

    expect(result.output.research.notes).toBe("notes:TypeScript agents");
    expect(result.output.path).toBe("quick");
    expect(result.output.draft.draft).toBe("final draft");
  });

  it("uses explicit branch logic to choose between agents", async () => {
    const planner = createAgent({
      name: "planner",
      model: createFakeModel([{ text: "planning answer" }]),
    });

    const support = createAgent({
      name: "support",
      model: createFakeModel([{ text: "support answer" }]),
    });

    const workflow = createMainWorkflow({
      name: "routing-flow",
      input: z.object({
        message: z.string(),
      }),
      agents: [planner, support] as const,
    })
      .step("route", async ({ input, agents }) => {
        const target = input.message.includes("help")
          ? agents.support
          : agents.planner;
        const result = await target.run(input.message);

        if (result.status !== "success") {
          throw result.error;
        }

        return result.output;
      })
      .commit();

    const supportResult = await workflow.run({
      message: "help me with billing",
    });
    const plannerResult = await workflow.run({
      message: "plan my next sprint",
    });

    expect(supportResult.status).toBe("success");
    expect(plannerResult.status).toBe("success");

    if (supportResult.status === "success") {
      expect(supportResult.output.route).toBe("support answer");
    }

    if (plannerResult.status === "success") {
      expect(plannerResult.output.route).toBe("planning answer");
    }
  });

  it("returns a paused result with explicit state", async () => {
    const workflow = createMainWorkflow({
      name: "pause-flow",
      input: z.object({
        ticketId: z.string(),
      }),
    })
      .step("review", async ({ input }) => {
        return pause({ ticketId: input.ticketId }, "Need human approval");
      })
      .commit();

    const result = await workflow.run({
      ticketId: "T-1",
    });

    expect(result.status).toBe("paused");

    if (result.status !== "paused") {
      return;
    }

    expect(result.state.lastStep).toBe("review");
    expect(result.reason).toBe("Need human approval");
  });
});
