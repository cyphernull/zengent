import { createModelAdapter, createOllamaFormat } from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolDescriptor } from "../core/types.js";

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
  name?: string;
  arguments?: unknown;
}

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaAdapterOptions {
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  keepAlive?: string | number;
}

function toToolSchema(schema?: JsonSchema) {
  return schema ?? {
    type: "object",
    additionalProperties: true,
  };
}

function toOllamaMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (request.instructions) {
    messages.push({
      role: "system",
      content: request.instructions,
    });
  }

  for (const message of request.messages) {
    if (message.role === "assistant" && Array.isArray(message.metadata?.toolCalls)) {
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: (message.metadata.toolCalls as Array<{
          id: string;
          name: string;
          input: unknown;
        }>).map((call) => ({
          function: {
            name: call.name,
            arguments: call.input,
          },
          id: call.id,
        })),
      });
      continue;
    }

    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    if (message.toolCallId) {
      payload.tool_call_id = message.toolCallId;
    }

    messages.push(payload);
  }

  return messages;
}

export function ollamaAdapter(
  options: string | OllamaAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  return createModelAdapter({
    name: `ollama:${config.model}`,
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ): Promise<ModelResponse<TOutput>> {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the Ollama adapter.");
      }

      const response = await fetchImpl(
        `${config.baseUrl ?? "http://127.0.0.1:11434"}/api/chat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...config.headers,
          },
          signal: request.signal ?? context.signal,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            messages: toOllamaMessages(request),
            ...(request.tools
              ? {
                  tools: request.tools.map((tool: ToolDescriptor) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: toToolSchema(tool.inputSchema),
                    },
                  })),
                }
              : {}),
            ...(createOllamaFormat(request)
              ? {
                  format: createOllamaFormat(request),
                }
              : {}),
            ...(config.keepAlive !== undefined
              ? {
                  keep_alive: config.keepAlive,
                }
              : {}),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Ollama adapter failed with ${response.status} ${response.statusText}.`);
      }

      const payload = (await response.json()) as OllamaResponse;

      return {
        text: payload.message?.content,
        toolCalls: payload.message?.tool_calls?.map((call, index) => ({
          id: `tool_${index + 1}`,
          name: call.function?.name ?? call.name ?? "tool",
          input: call.function?.arguments ?? call.arguments ?? {},
        })),
        finishReason:
          payload.done_reason === "length"
            ? "length"
            : payload.message?.tool_calls && payload.message.tool_calls.length > 0
              ? "tool_calls"
              : "stop",
        usage:
          payload.prompt_eval_count !== undefined || payload.eval_count !== undefined
            ? {
                inputTokens: payload.prompt_eval_count,
                outputTokens: payload.eval_count,
                totalTokens:
                  (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
              }
            : undefined,
        raw: payload,
      };
    },
  });
}
