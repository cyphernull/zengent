import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createZengent } from "../src/app/create-zengent.js";
import { createRunContext } from "../src/core/context.js";
import {
  createMcpTool,
  createMcpToolSet,
  discoverMcpTools,
  type McpClientLike,
} from "../src/integrations/mcp.js";
import { createFakeModel } from "../src/testing/fake-model.js";

describe("mcp integration", () => {
  it("wraps a single MCP tool as a zengent tool", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const client: McpClientLike = {
      async callTool(params) {
        calls.push(params);
        return {
          content: {
            forecast: "sunny",
          },
        };
      },
    };

    const weather = createMcpTool({
      client,
      name: "weather",
      description: "Get weather by city",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        forecast: z.string(),
      }),
    });

    const result = await weather.invoke(
      {
        city: "Tokyo",
      },
      createRunContext()
    );

    expect(result).toEqual({
      forecast: "sunny",
    });
    expect(calls).toEqual([
      {
        name: "weather",
        arguments: {
          city: "Tokyo",
        },
      },
    ]);
  });

  it("wraps an explicit MCP tool set", () => {
    const client: McpClientLike = {
      async callTool() {
        return {
          content: {},
        };
      },
    };

    const tools = createMcpToolSet({
      client,
      tools: [
        {
          name: "weather",
          description: "Get weather",
        },
        {
          name: "news",
          description: "Get news",
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["weather", "news"]);
  });

  it("discovers MCP tools from clients that support listTools", async () => {
    const client: McpClientLike = {
      async callTool() {
        return {
          content: {
            ok: true,
          },
        };
      },
      async listTools() {
        return [
          {
            name: "weather",
            description: "Get weather",
          },
          {
            name: "news",
            description: "Get news",
          },
        ];
      },
    };

    const tools = await discoverMcpTools({
      client,
      include: ["weather"],
      overrides: {
        weather: {
          inputSchema: z.object({
            city: z.string(),
          }),
          outputSchema: z.object({
            ok: z.boolean(),
          }),
        },
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("weather");
    expect(tools[0]?.description).toBe("Get weather");
  });

  it("fails discovery clearly when the client does not support listTools", async () => {
    const client: McpClientLike = {
      async callTool() {
        return {
          content: {},
        };
      },
    };

    await expect(
      discoverMcpTools({
        client,
      })
    ).rejects.toThrow("MCP discovery requires a client with listTools().");
  });

  it("allows discovered MCP tools to be called by agents", async () => {
    const app = createZengent();
    const client: McpClientLike = {
      async callTool(params) {
        return {
          content: {
            city: String(params.arguments?.city ?? ""),
            forecast: "sunny",
          },
        };
      },
      async listTools() {
        return [
          {
            name: "weather",
            description: "Get weather by city",
          },
        ];
      },
    };

    const [weather] = await discoverMcpTools({
      client,
      overrides: {
        weather: {
          inputSchema: z.object({
            city: z.string(),
          }),
          outputSchema: z.object({
            city: z.string(),
            forecast: z.string(),
          }),
        },
      },
    });

    if (!weather) {
      throw new Error("Expected weather tool");
    }

    const agent = app.agent({
      name: "planner",
      inputSchema: z.string(),
      outputSchema: z.string(),
      instructions: "You are a travel planner.",
      model: createFakeModel([
        {
          toolCalls: [
            {
              id: "call_1",
              name: "weather",
              input: {
                city: "Tokyo",
              },
            },
          ],
        },
        {
          text: "Tokyo looks sunny.",
        },
      ]),
      tools: [weather],
    });

    const result = await agent.run("Plan Tokyo");

    expect(result.status).toBe("success");
    expect(result.toolTraces[0]?.output).toEqual({
      city: "Tokyo",
      forecast: "sunny",
    });
  });
});
