import { z } from "zod";

import { defineTool } from "../tool/define-tool.js";
import type { JsonSchema } from "../core/types.js";

export interface McpClientLike {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content: unknown;
  }>;
}

const mcpInputSchema = z.object({}).catchall(z.unknown());

export function createMcpTool(options: {
  client: McpClientLike;
  name: string;
  description: string;
  inputSchema?: JsonSchema;
}) {
  return defineTool({
    name: options.name,
    description: options.description,
    inputSchema: mcpInputSchema,
    jsonSchema: options.inputSchema,
    outputSchema: z.unknown(),
    execute: async (input) => {
      const result = await options.client.callTool({
        name: options.name,
        arguments: input as Record<string, unknown>,
      });

      return result.content;
    },
  });
}

export function createMcpToolSet(
  client: McpClientLike,
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: JsonSchema;
  }>
) {
  return tools.map((tool) =>
    createMcpTool({
      client,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })
  );
}
