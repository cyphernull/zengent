import { createModelAdapter, requireApiKey } from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolDescriptor, ToolCall } from "../core/types.js";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: "assistant";
  content?: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
      }
  >;
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface AnthropicAdapterOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  version?: string;
  maxTokens?: number;
}

function combineSystemText(request: ModelRequest): string | undefined {
  const segments: string[] = [];

  if (request.instructions) {
    segments.push(request.instructions);
  }

  for (const message of request.messages) {
    if (message.role === "system" && message.content) {
      segments.push(message.content);
    }
  }

  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function toAnthropicToolSchema(schema?: JsonSchema) {
  return schema ?? {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    output.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }

    flushToolResults();

    if (
      message.role === "assistant" &&
      Array.isArray(message.metadata?.toolCalls)
    ) {
      const parts: AnthropicContentBlock[] = [];

      if (message.content) {
        parts.push({
          type: "text",
          text: message.content,
        });
      }

      for (const toolCall of message.metadata.toolCalls as Array<{
        id: string;
        name: string;
        input: unknown;
      }>) {
        parts.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }

      output.push({
        role: "assistant",
        content: parts,
      });
      continue;
    }

    output.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }

  flushToolResults();

  return output;
}

function toFinishReason(
  stopReason: AnthropicResponse["stop_reason"],
  toolCalls: ToolCall[]
): ModelResponse["finishReason"] {
  if (toolCalls.length > 0 || stopReason === "tool_use") {
    return "tool_calls";
  }

  if (stopReason === "max_tokens") {
    return "length";
  }

  return "stop";
}

export function anthropicAdapter(
  options: string | AnthropicAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  return createModelAdapter({
    name: `anthropic:${config.model}`,
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ): Promise<ModelResponse<TOutput>> {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the Anthropic adapter.");
      }

      const apiKey = requireApiKey("Anthropic", config.apiKey, "ANTHROPIC_API_KEY");

      const response = await fetchImpl(
        `${config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": config.version ?? "2023-06-01",
            "x-api-key": apiKey,
            ...config.headers,
          },
          signal: request.signal ?? context.signal,
          body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens ?? 1024,
            ...(combineSystemText(request)
              ? {
                  system: combineSystemText(request),
                }
              : {}),
            messages: toAnthropicMessages(request.messages),
            ...(request.tools
              ? {
                  tools: request.tools.map((tool: ToolDescriptor) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: toAnthropicToolSchema(tool.inputSchema),
                  })),
                }
              : {}),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Anthropic adapter failed with ${response.status} ${response.statusText}.`
        );
      }

      const payload = (await response.json()) as AnthropicResponse;
      const textBlocks = (payload.content ?? []).filter(
        (block): block is AnthropicTextBlock =>
          block.type === "text"
      );
      const toolCalls = (payload.content ?? [])
        .filter(
          (block): block is AnthropicToolUseBlock =>
            block.type === "tool_use"
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input,
        }));

      return {
        text:
          textBlocks.length > 0
            ? textBlocks.map((block) => block.text).join("\n")
            : undefined,
        toolCalls,
        finishReason: toFinishReason(payload.stop_reason, toolCalls),
        usage: payload.usage
          ? {
              inputTokens: payload.usage.input_tokens,
              outputTokens: payload.usage.output_tokens,
              totalTokens:
                (payload.usage.input_tokens ?? 0) +
                (payload.usage.output_tokens ?? 0),
            }
          : undefined,
        raw: payload,
      };
    },
  });
}
