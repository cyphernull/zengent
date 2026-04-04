import {
  createModelAdapter,
  createOpenAICompatibleResponseFormat,
  createOpenAICompatibleStream,
  requireApiKey,
} from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolDescriptor } from "../core/types.js";

interface XAIFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface XAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: XAIFunctionToolCall[];
}

interface XAIResponse {
  choices: Array<{
    finish_reason?: string;
    message: {
      content?: string | null;
      tool_calls?: XAIFunctionToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface XAIAdapterOptions {
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

function toXAIMessages(messages: Message[]): XAIMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const payload: XAIMessage = {
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

    const payload: XAIMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    return payload;
  });
}

export function xaiAdapter(
  options: string | XAIAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  return createModelAdapter({
    name: `xai:${config.model}`,
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ): Promise<ModelResponse<TOutput>> {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the xAI adapter.");
      }

      const apiKey = requireApiKey("xAI", config.apiKey, "XAI_API_KEY");

      const response = await fetchImpl(
        `${config.baseUrl ?? "https://api.x.ai/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...config.headers,
          },
          signal: request.signal ?? context.signal,
          body: JSON.stringify({
            model: config.model,
            messages: [
              ...(request.instructions
                ? [{ role: "system", content: request.instructions }]
                : []),
              ...toXAIMessages(request.messages),
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
            ...(createOpenAICompatibleResponseFormat(request)
              ? {
                  response_format: createOpenAICompatibleResponseFormat(request),
                }
              : {}),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`xAI adapter failed with ${response.status} ${response.statusText}.`);
      }

      const payload = (await response.json()) as XAIResponse;
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
    streamGenerate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ) {
      const fetchImpl = config.fetch ?? globalThis.fetch;

      if (!fetchImpl) {
        throw new Error("No fetch implementation is available for the xAI adapter.");
      }

      const apiKey = requireApiKey("xAI", config.apiKey, "XAI_API_KEY");

      const responsePromise = fetchImpl(
        `${config.baseUrl ?? "https://api.x.ai/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...config.headers,
          },
          signal: request.signal ?? context.signal,
          body: JSON.stringify({
            model: config.model,
            stream: true,
            messages: [
              ...(request.instructions
                ? [{ role: "system", content: request.instructions }]
                : []),
              ...toXAIMessages(request.messages),
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
            ...(createOpenAICompatibleResponseFormat(request)
              ? {
                  response_format: createOpenAICompatibleResponseFormat(request),
                }
              : {}),
          }),
        }
      ).then((response) => {
        if (!response.ok) {
          throw new Error(`xAI adapter failed with ${response.status} ${response.statusText}.`);
        }

        return response;
      });
      const streamPromise = responsePromise.then((response) =>
        createOpenAICompatibleStream<TOutput>(response)
      );
      const textStream = (async function* () {
        const stream = await streamPromise;
        yield* stream;
      })();

      return {
        result: streamPromise.then((stream) => stream.result),
        textStream,
        async *[Symbol.asyncIterator]() {
          yield* textStream;
        },
      };
    },
  });
}
