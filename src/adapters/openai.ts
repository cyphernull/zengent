import { createModelAdapter, createOpenAICompatibleResponseFormat, requireApiKey } from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolDescriptor } from "../core/types.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatCompletionResponse {
  choices: Array<{
    finish_reason?: string;
    message: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenAIAdapterOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

function toToolSchema(schema?: JsonSchema) {
  return schema ?? {
    type: "object",
    additionalProperties: true,
  };
}

function toOpenAIMessages(messages: Message[]): OpenAIChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const payload: OpenAIChatMessage = {
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

    if (
      message.role === "assistant" &&
      Array.isArray(message.metadata?.toolCalls)
    ) {
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

    const payload: OpenAIChatMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    return payload;
  });
}

function normalizeText(content?: string | null) {
  return content ?? undefined;
}

export function openaiAdapter(
  options: string | OpenAIAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  return createModelAdapter({
    name: `openai:${config.model}`,
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ): Promise<ModelResponse<TOutput>> {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the OpenAI adapter.");
      }

      const apiKey = requireApiKey("OpenAI", config.apiKey, "OPENAI_API_KEY");

      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...config.headers,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            ...(request.instructions
              ? [
                  {
                    role: "system",
                    content: request.instructions,
                  },
                ]
              : []),
            ...toOpenAIMessages(request.messages),
          ],
          tools: request.tools?.map((tool: ToolDescriptor) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: toToolSchema(tool.inputSchema),
            },
          })),
          response_format: createOpenAICompatibleResponseFormat(request),
        }),
      };

      if (request.signal ?? context.signal) {
        requestInit.signal = request.signal ?? context.signal ?? null;
      }

      const response = await fetchImpl(
        `${config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
        requestInit
      );

      if (!response.ok) {
        throw new Error(`OpenAI adapter failed with ${response.status} ${response.statusText}.`);
      }

      const payload =
        (await response.json()) as OpenAIChatCompletionResponse;
      const choice = payload.choices[0];
      const toolCalls = choice?.message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}"),
      }));

      return {
        text: normalizeText(choice?.message.content),
        toolCalls,
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
