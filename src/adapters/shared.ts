import { z } from "zod";

import { createAsyncQueue } from "../core/async-queue.js";
import type { JsonSchema, ModelAdapter, ModelRequest, ModelResponse, ModelStream, RunContext } from "../core/types.js";

export function createModelAdapter(config: {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
  streamGenerate?<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): ModelStream<TOutput>;
}): ModelAdapter {
  return {
    name: config.name,
    generate: config.generate,
    streamGenerate: config.streamGenerate,
  };
}

export function resolveApiKey(explicitApiKey: string | undefined, envVarName: string) {
  return explicitApiKey ?? process.env[envVarName];
}

export function requireApiKey(
  providerName: string,
  explicitApiKey: string | undefined,
  envVarName: string
) {
  const apiKey = resolveApiKey(explicitApiKey, envVarName);

  if (!apiKey) {
    throw new Error(
      `${providerName} adapter requires an API key. Pass apiKey explicitly or set ${envVarName}.`
    );
  }

  return apiKey;
}

function toStructuredOutputJsonSchema<TOutput>(
  request: ModelRequest<TOutput>
): JsonSchema | undefined {
  if (!request.outputSchema) {
    return undefined;
  }

  return z.toJSONSchema(request.outputSchema as z.ZodTypeAny) as JsonSchema;
}

export function createOpenAICompatibleResponseFormat<TOutput>(
  request: ModelRequest<TOutput>
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema) {
    return undefined;
  }

  return {
    type: "json_schema" as const,
    json_schema: {
      name: "zengent_output",
      strict: true,
      schema,
    },
  };
}

export function createJsonModeResponseFormat<TOutput>(
  request: ModelRequest<TOutput>
) {
  if (!request.outputSchema) {
    return undefined;
  }

  return {
    type: "json_object" as const,
  };
}

export function createGeminiGenerationConfig<TOutput>(
  request: ModelRequest<TOutput>,
  options?: {
    maxOutputTokens?: number;
  }
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema && options?.maxOutputTokens === undefined) {
    return undefined;
  }

  return {
    ...(options?.maxOutputTokens !== undefined
      ? {
          maxOutputTokens: options.maxOutputTokens,
        }
      : {}),
    ...(schema
      ? {
          responseMimeType: "application/json",
          responseSchema: schema,
        }
      : {}),
  };
}

export function createOllamaFormat<TOutput>(request: ModelRequest<TOutput>) {
  return toStructuredOutputJsonSchema(request);
}

export function createStructuredOutputHint<TOutput>(
  request: ModelRequest<TOutput>
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema) {
    return undefined;
  }

  return [
    "Return only valid JSON that matches the required schema.",
    "Do not wrap the JSON in Markdown or code fences.",
    "Do not include any text before or after the JSON.",
    "Required JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

export function appendStructuredOutputHint<TOutput>(
  instructions: string | undefined,
  request: ModelRequest<TOutput>
) {
  const hint = createStructuredOutputHint(request);

  if (!hint) {
    return instructions;
  }

  return instructions ? `${instructions}\n\n${hint}` : hint;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createTextModelStream<TOutput>(
  run: (emit: (chunk: string) => void) => Promise<ModelResponse<TOutput>>
): ModelStream<TOutput> {
  const queue = createAsyncQueue<string>();
  const textStream = queue.stream();

  const result = (async () => {
    try {
      const response = await run((chunk) => {
        if (chunk.length > 0) {
          queue.push(chunk);
        }
      });
      queue.finish();
      return response;
    } catch (error) {
      queue.fail(toError(error));
      throw error;
    }
  })();

  return {
    result,
    textStream,
    [Symbol.asyncIterator]() {
      return textStream[Symbol.asyncIterator]();
    },
  };
}

export function streamGenerateFromGenerate<TOutput>(
  generate: (
    request: ModelRequest<TOutput>,
    context: RunContext
  ) => Promise<ModelResponse<TOutput>>,
  request: ModelRequest<TOutput>,
  context: RunContext
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    const response = await generate(request, context);

    if (response.text) {
      emit(response.text);
    }

    return response;
  });
}

interface OpenAICompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function createOpenAICompatibleStream<TOutput>(
  response: Response
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    if (!response.body) {
      throw new Error("Streaming response body is missing.");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let text = "";
    let finishReason: ModelResponse["finishReason"];
    let usage: ModelResponse["usage"];
    const rawChunks: OpenAICompatibleStreamChunk[] = [];
    const toolCallsByIndex = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
      }
    >();

    const processEvent = (event: string) => {
      const data = event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data || data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(data) as OpenAICompatibleStreamChunk;
      rawChunks.push(payload);

      for (const choice of payload.choices ?? []) {
        const content = choice.delta?.content ?? undefined;

        if (content) {
          text += content;
          emit(content);
        }

        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const current = toolCallsByIndex.get(index) ?? {
            id: toolCall.id ?? `tool_${index + 1}`,
            name: toolCall.function?.name ?? "tool",
            arguments: "",
          };

          if (toolCall.id) {
            current.id = toolCall.id;
          }

          if (toolCall.function?.name) {
            current.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            current.arguments += toolCall.function.arguments;
          }

          toolCallsByIndex.set(index, current);
        }

        if (choice.finish_reason === "tool_calls") {
          finishReason = "tool_calls";
        } else if (choice.finish_reason === "length") {
          finishReason = "length";
        } else if (choice.finish_reason === "stop") {
          finishReason = "stop";
        }
      }

      if (payload.usage) {
        usage = {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        processEvent(event);
      }
    }

    buffer += decoder.decode();

    if (buffer.trim().length > 0) {
      for (const event of buffer.split("\n\n")) {
        if (event.trim().length > 0) {
          processEvent(event);
        }
      }
    }

    return {
      text: text || undefined,
      toolCalls:
        toolCallsByIndex.size > 0
          ? Array.from(toolCallsByIndex.entries())
              .sort(([left], [right]) => left - right)
              .map(([, call]) => ({
                id: call.id,
                name: call.name,
                input: JSON.parse(call.arguments || "{}"),
              }))
          : undefined,
      finishReason: finishReason ?? "stop",
      usage,
      raw: rawChunks,
    };
  });
}
