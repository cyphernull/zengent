import {
  createGeminiGenerationConfig,
  createModelAdapter,
  requireApiKey,
  streamGenerateFromGenerate,
} from "./shared.js";
import type { JsonSchema, Message, ModelRequest, ModelResponse, RunContext, ToolCall } from "../core/types.js";

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args?: unknown;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: unknown;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      role?: "model";
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiAdapterOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  apiVersion?: string;
  maxOutputTokens?: number;
}

function combineSystemInstruction(request: ModelRequest) {
  const segments: string[] = [];

  if (request.instructions) {
    segments.push(request.instructions);
  }

  for (const message of request.messages) {
    if (message.role === "system" && message.content) {
      segments.push(message.content);
    }
  }

  if (segments.length === 0) {
    return undefined;
  }

  return {
    parts: [{ text: segments.join("\n\n") }],
  };
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return {
      content,
    };
  }
}

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const output: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      output.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.name ?? "tool",
              response: {
                toolCallId: message.toolCallId,
                result: parseToolResult(message.content),
              },
            },
          },
        ],
      });
      continue;
    }

    if (
      message.role === "assistant" &&
      Array.isArray(message.metadata?.toolCalls)
    ) {
      const parts: GeminiPart[] = [];

      if (message.content) {
        parts.push({
          text: message.content,
        });
      }

      for (const toolCall of message.metadata.toolCalls as Array<{
        id: string;
        name: string;
        input: unknown;
      }>) {
        parts.push({
          functionCall: {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.input,
          },
        });
      }

      output.push({
        role: "model",
        parts,
      });
      continue;
    }

    output.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }

  return output;
}

function toGeminiToolDeclarations(request: ModelRequest) {
  if (!request.tools || request.tools.length === 0) {
    return undefined;
  }

  return [
    {
      functionDeclarations: request.tools.map(
        (tool): GeminiFunctionDeclaration => ({
          name: tool.name,
          description: tool.description,
          parameters:
            tool.inputSchema ?? {
              type: "object",
              properties: {},
              additionalProperties: true,
            },
        })
      ),
    },
  ];
}

function toFinishReason(
  finishReason: string | undefined,
  toolCalls: ToolCall[]
): ModelResponse["finishReason"] {
  if (toolCalls.length > 0) {
    return "tool_calls";
  }

  if (finishReason === "MAX_TOKENS") {
    return "length";
  }

  return "stop";
}

export function geminiAdapter(
  options: string | GeminiAdapterOptions
) {
  const config =
    typeof options === "string"
      ? {
          model: options,
        }
      : options;

  const generate = async <TOutput>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>> => {
    const fetchImpl = config.fetch ?? globalThis.fetch;

    if (!fetchImpl) {
      throw new Error("No fetch implementation is available for the Gemini adapter.");
    }

    const apiKey = requireApiKey(
      "Gemini",
      config.apiKey,
      "GOOGLE_GENERATIVE_AI_API_KEY"
    );

    const url = new URL(
      `${config.baseUrl ?? "https://generativelanguage.googleapis.com"}/${config.apiVersion ?? "v1beta"}/models/${config.model}:generateContent`
    );

    url.searchParams.set("key", apiKey);

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...config.headers,
      },
      signal: request.signal ?? context.signal,
      body: JSON.stringify({
        ...(combineSystemInstruction(request)
          ? {
              system_instruction: combineSystemInstruction(request),
            }
          : {}),
        contents: toGeminiContents(request.messages),
        ...(toGeminiToolDeclarations(request)
          ? {
              tools: toGeminiToolDeclarations(request),
            }
          : {}),
        ...(createGeminiGenerationConfig(request, {
          maxOutputTokens: config.maxOutputTokens,
        })
          ? {
              generationConfig: createGeminiGenerationConfig(request, {
                maxOutputTokens: config.maxOutputTokens,
              }),
            }
          : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini adapter failed with ${response.status} ${response.statusText}.`
      );
    }

    const payload = (await response.json()) as GeminiResponse;
    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls = parts
      .filter(
        (part): part is Required<Pick<GeminiPart, "functionCall">> =>
          Boolean(part.functionCall?.name)
      )
      .map((part, index) => ({
        id: part.functionCall?.id ?? `tool_${index + 1}`,
        name: part.functionCall?.name ?? "tool",
        input: part.functionCall?.args ?? {},
      }));
    const text = parts
      .filter((part) => typeof part.text === "string" && part.text.length > 0)
      .map((part) => part.text as string)
      .join("\n");

    return {
      text: text || undefined,
      toolCalls,
      finishReason: toFinishReason(candidate?.finishReason, toolCalls),
      usage: payload.usageMetadata
        ? {
            inputTokens: payload.usageMetadata.promptTokenCount,
            outputTokens: payload.usageMetadata.candidatesTokenCount,
            totalTokens: payload.usageMetadata.totalTokenCount,
          }
        : undefined,
      raw: payload,
    };
  };

  return createModelAdapter({
    name: `gemini:${config.model}`,
    generate,
    streamGenerate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ) {
      return streamGenerateFromGenerate(generate, request, context);
    },
  });
}
