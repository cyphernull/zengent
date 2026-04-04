import { createModelAdapter, requireApiKey } from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolDescriptor } from "../core/types.js";

interface OpenRouterFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterFunctionToolCall[];
}

interface OpenRouterResponse {
  choices: Array<{
    finish_reason?: string;
    message: {
      content?: string | null;
      tool_calls?: OpenRouterFunctionToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenRouterAdapterOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  referer?: string;
  title?: string;
}

function toToolSchema(schema?: JsonSchema) {
  return schema ?? {
    type: "object",
    additionalProperties: true,
  };
}

function toOpenRouterMessages(messages: Message[]): OpenRouterMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const payload: OpenRouterMessage = {
        role: "tool",
        content: message.content,
      };

      if (message.name) {
        payload.name = message.name;
      }

      if (message.toolCallId) {
        payload.tool_call_id = message.toolCallId;
      }

      return payload;
    }

    if (message.role === "assistant" && Array.isArray(message.metadata?.toolCalls)) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: (message.metadata.toolCalls as Array<{
          id: string;
          name: string;
          input: unknown;
        }>).map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        })),
      };
    }

    const payload: OpenRouterMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    return payload;
  });
}

export function openRouterAdapter(
  options: string | OpenRouterAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  return createModelAdapter({
    name: `openrouter:${config.model}`,
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ): Promise<ModelResponse<TOutput>> {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the OpenRouter adapter.");
      }

      const apiKey = requireApiKey("OpenRouter", config.apiKey, "OPENROUTER_API_KEY");

      const response = await fetchImpl(
        `${config.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...(config.referer ? { "HTTP-Referer": config.referer } : {}),
            ...(config.title ? { "X-Title": config.title } : {}),
            ...config.headers,
          },
          signal: request.signal ?? context.signal,
          body: JSON.stringify({
            model: config.model,
            messages: [
              ...(request.instructions
                ? [{ role: "system", content: request.instructions }]
                : []),
              ...toOpenRouterMessages(request.messages),
            ],
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
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `OpenRouter adapter failed with ${response.status} ${response.statusText}.`
        );
      }

      const payload = (await response.json()) as OpenRouterResponse;
      const choice = payload.choices[0];

      return {
        text: choice?.message.content ?? undefined,
        toolCalls: choice?.message.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || "{}"),
        })),
        finishReason:
          choice?.finish_reason === "tool_calls"
            ? "tool_calls"
            : choice?.finish_reason === "length"
              ? "length"
              : "stop",
        usage: payload.usage
          ? {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens,
            }
          : undefined,
        raw: payload,
      };
    },
  });
}
