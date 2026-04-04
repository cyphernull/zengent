import { z, type ZodType } from "zod";

import { ConfigError } from "../core/errors.js";
import type { InferSchema } from "../core/types.js";
import { defineTool } from "../tool/define-tool.js";
import type { ToolDefinition } from "../tool/tool-types.js";

export interface McpListedTool {
  name: string;
  description?: string;
}

export interface McpClientLike {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content: unknown;
  }>;
  listTools?(): Promise<McpListedTool[]>;
}

const mcpInputSchema = z.object({}).catchall(z.unknown());
const mcpOutputSchema = z.unknown();

type DefaultMcpInputSchema = typeof mcpInputSchema;
type DefaultMcpOutputSchema = typeof mcpOutputSchema;

export interface McpToolOverride<
  TInputSchema extends ZodType = ZodType,
  TOutputSchema extends ZodType = ZodType,
> {
  description?: string;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
}

export interface CreateMcpToolOptions<
  TInputSchema extends ZodType = DefaultMcpInputSchema,
  TOutputSchema extends ZodType = DefaultMcpOutputSchema,
> extends McpToolOverride<TInputSchema, TOutputSchema> {
  client: McpClientLike;
  name: string;
}

export interface CreateMcpToolSetOptions {
  client: McpClientLike;
  tools: Array<
    {
      name: string;
    } & McpToolOverride
  >;
}

export interface DiscoverMcpToolsOptions {
  client: McpClientLike;
  include?: string[];
  exclude?: string[];
  overrides?: Record<string, McpToolOverride>;
}

export function createMcpTool<
  TInputSchema extends ZodType = DefaultMcpInputSchema,
  TOutputSchema extends ZodType = DefaultMcpOutputSchema,
>(
  options: CreateMcpToolOptions<TInputSchema, TOutputSchema>
): ToolDefinition<TInputSchema, InferSchema<TOutputSchema>, string> {
  const inputSchema = (options.inputSchema ?? mcpInputSchema) as TInputSchema;
  const outputSchema = (options.outputSchema ?? mcpOutputSchema) as TOutputSchema;

  return defineTool({
    name: options.name,
    description: options.description ?? `MCP tool "${options.name}"`,
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const result = await options.client.callTool({
        name: options.name,
        arguments: input as Record<string, unknown>,
      });

      return result.content as InferSchema<TOutputSchema>;
    },
  });
}

export function createMcpToolSet(options: CreateMcpToolSetOptions) {
  return options.tools.map((tool) =>
    createMcpTool({
      client: options.client,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })
  );
}

export async function discoverMcpTools(options: DiscoverMcpToolsOptions) {
  if (!options.client.listTools) {
    throw new ConfigError(
      "MCP discovery requires a client with listTools()."
    );
  }

  const includeSet = options.include ? new Set(options.include) : undefined;
  const excludeSet = options.exclude ? new Set(options.exclude) : undefined;
  const listedTools = await options.client.listTools();

  return listedTools
    .filter((tool) => {
      if (includeSet && !includeSet.has(tool.name)) {
        return false;
      }

      if (excludeSet?.has(tool.name)) {
        return false;
      }

      return true;
    })
    .map((tool) =>
      createMcpTool({
        client: options.client,
        name: tool.name,
        description:
          options.overrides?.[tool.name]?.description ?? tool.description,
        inputSchema: options.overrides?.[tool.name]?.inputSchema,
        outputSchema: options.overrides?.[tool.name]?.outputSchema,
      })
    );
}
