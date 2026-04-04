import { z } from "zod";
import { describe, expect, it } from "vitest";

import { anthropicAdapter } from "../src/adapters/anthropic.js";
import { deepseekAdapter } from "../src/adapters/deepseek.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { kimiAdapter } from "../src/adapters/kimi.js";
import { ollamaAdapter } from "../src/adapters/ollama.js";
import { openaiAdapter } from "../src/adapters/openai.js";
import { openRouterAdapter } from "../src/adapters/openrouter.js";
import { xaiAdapter } from "../src/adapters/xai.js";
import { createAgent } from "../src/agent/create-agent.js";
import { createRunContext } from "../src/core/context.js";
import { createFakeModel } from "../src/testing/fake-model.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

async function withEnv<TValue>(
  key: string,
  value: string | undefined,
  run: () => Promise<TValue>
) {
  const previous = process.env[key];

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

function textResponse(body: string, init?: ResponseInit) {
  return new Response(body, {
    status: 200,
    ...init,
  });
}

function createFetchStub(
  payload: unknown,
  capture: FetchCall[],
  init?: ResponseInit
): typeof fetch {
  return async (input, requestInit) => {
    capture.push({
      url: String(input),
      init: requestInit ?? {},
    });
    return jsonResponse(payload, init);
  };
}

function createTextFetchStub(
  body: string,
  capture: FetchCall[],
  init?: ResponseInit
): typeof fetch {
  return async (input, requestInit) => {
    capture.push({
      url: String(input),
      init: requestInit ?? {},
    });
    return textResponse(body, init);
  };
}

function getJsonBody(call: FetchCall) {
  return JSON.parse(String(call.init.body ?? "{}"));
}

async function collectStreamChunks(stream: AsyncIterable<string>) {
  const chunks: string[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

async function exerciseAdapter(adapter: {
  generate: (
    request: {
      instructions?: string;
      messages: Array<{ role: "user" | "assistant" | "tool"; content: string; metadata?: Record<string, unknown>; name?: string; toolCallId?: string }>;
      tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    },
    context: ReturnType<typeof createRunContext>
  ) => Promise<{
    text?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  }>;
}) {
  return adapter.generate(
    {
      instructions: "Be helpful",
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "search",
          description: "Search the web",
          inputSchema: {
            type: "object",
            properties: {
              q: {
                type: "string",
              },
            },
          },
        },
      ],
    },
    createRunContext()
  );
}

async function exerciseStructuredAdapter(adapter: {
  generate: (
    request: {
      instructions?: string;
      messages: Array<{ role: "user" | "assistant" | "tool"; content: string; metadata?: Record<string, unknown>; name?: string; toolCallId?: string }>;
      outputSchema?: z.ZodTypeAny;
    },
    context: ReturnType<typeof createRunContext>
  ) => Promise<{
    text?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  }>;
}) {
  return adapter.generate(
    {
      instructions: "Be helpful",
      messages: [{ role: "user", content: "Hello" }],
      outputSchema: z.object({
        answer: z.string(),
      }),
    },
    createRunContext()
  );
}

describe("adapters", () => {
  it("normalizes fake and OpenAI adapters to the same contract", async () => {
    const fake = createFakeModel([
      {
        text: "hi",
        toolCalls: [{ id: "1", name: "search", input: { q: "hello" } }],
      },
    ]);
    const calls: FetchCall[] = [];
    const openai = openaiAdapter({
      model: "gpt-test",
      apiKey: "openai-key",
      fetch: createFetchStub(
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "hi",
                tool_calls: [
                  {
                    id: "1",
                    type: "function",
                    function: {
                      name: "search",
                      arguments: "{\"q\":\"hello\"}",
                    },
                  },
                ],
              },
            },
          ],
        },
        calls
      ),
    });

    const [fakeResult, openaiResult] = await Promise.all([
      exerciseAdapter(fake),
      exerciseAdapter(openai),
    ]);

    expect(fakeResult).toEqual({
      text: "hi",
      toolCalls: [{ id: "1", name: "search", input: { q: "hello" } }],
    });
    expect(openaiResult.text).toBe(fakeResult.text);
    expect(openaiResult.toolCalls).toEqual(fakeResult.toolCalls);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer openai-key",
    });
  });

  it("prefers explicit apiKey over environment variables", async () => {
    const calls: FetchCall[] = [];

    await withEnv("OPENAI_API_KEY", "env-openai-key", async () => {
      const adapter = openaiAdapter({
        model: "gpt-test",
        apiKey: "explicit-openai-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "ok" } }],
          },
          calls
        ),
      });

      await exerciseAdapter(adapter);
    });

    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer explicit-openai-key",
    });
  });

  it("falls back to provider environment variables when apiKey is omitted", async () => {
    const captures = {
      openai: [] as FetchCall[],
      anthropic: [] as FetchCall[],
      gemini: [] as FetchCall[],
      openrouter: [] as FetchCall[],
      deepseek: [] as FetchCall[],
      xai: [] as FetchCall[],
      kimi: [] as FetchCall[],
    };

    await withEnv("OPENAI_API_KEY", "env-openai-key", async () => {
      const adapter = openaiAdapter({
        model: "gpt-test",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "openai" } }],
          },
          captures.openai
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("ANTHROPIC_API_KEY", "env-anthropic-key", async () => {
      const adapter = anthropicAdapter({
        model: "claude-test",
        fetch: createFetchStub(
          {
            content: [{ type: "text", text: "anthropic" }],
            stop_reason: "end_turn",
          },
          captures.anthropic
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-gemini-key", async () => {
      const adapter = geminiAdapter({
        model: "gemini-test",
        fetch: createFetchStub(
          {
            candidates: [{ content: { parts: [{ text: "gemini" }] } }],
          },
          captures.gemini
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("OPENROUTER_API_KEY", "env-openrouter-key", async () => {
      const adapter = openRouterAdapter({
        model: "router-test",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "openrouter" } }],
          },
          captures.openrouter
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("DEEPSEEK_API_KEY", "env-deepseek-key", async () => {
      const adapter = deepseekAdapter({
        model: "deepseek-test",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "deepseek" } }],
          },
          captures.deepseek
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("XAI_API_KEY", "env-xai-key", async () => {
      const adapter = xaiAdapter({
        model: "grok-test",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "xai" } }],
          },
          captures.xai
        ),
      });
      await exerciseAdapter(adapter);
    });

    await withEnv("MOONSHOT_API_KEY", "env-moonshot-key", async () => {
      const adapter = kimiAdapter({
        model: "kimi-test",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "kimi" } }],
          },
          captures.kimi
        ),
      });
      await exerciseAdapter(adapter);
    });

    expect(captures.openai[0]?.init.headers).toMatchObject({
      authorization: "Bearer env-openai-key",
    });
    expect(captures.anthropic[0]?.init.headers).toMatchObject({
      "x-api-key": "env-anthropic-key",
    });
    expect(captures.gemini[0]?.url).toContain("key=env-gemini-key");
    expect(captures.openrouter[0]?.init.headers).toMatchObject({
      authorization: "Bearer env-openrouter-key",
    });
    expect(captures.deepseek[0]?.init.headers).toMatchObject({
      authorization: "Bearer env-deepseek-key",
    });
    expect(captures.xai[0]?.init.headers).toMatchObject({
      authorization: "Bearer env-xai-key",
    });
    expect(captures.kimi[0]?.init.headers).toMatchObject({
      authorization: "Bearer env-moonshot-key",
    });
  });

  it("builds dedicated requests for xAI, OpenRouter, DeepSeek, and Kimi", async () => {
    const configs = [
      {
        name: "xAI",
        adapter: xaiAdapter({
          model: "grok-4",
          apiKey: "xai-key",
          fetch: createFetchStub(
            {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: "ok",
                    tool_calls: [
                      {
                        id: "1",
                        type: "function",
                        function: {
                          name: "search",
                          arguments: "{\"q\":\"hi\"}",
                        },
                      },
                    ],
                  },
                },
              ],
            },
            []
          ),
        }),
        expectedUrl: "https://api.x.ai/v1/chat/completions",
      },
      {
        name: "OpenRouter",
        adapter: openRouterAdapter({
          model: "openai/gpt-4.1",
          apiKey: "router-key",
          referer: "https://zengent.dev",
          title: "zengent",
          fetch: createFetchStub(
            {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: "ok",
                    tool_calls: [
                      {
                        id: "1",
                        type: "function",
                        function: {
                          name: "search",
                          arguments: "{\"q\":\"hi\"}",
                        },
                      },
                    ],
                  },
                },
              ],
            },
            []
          ),
        }),
        expectedUrl: "https://openrouter.ai/api/v1/chat/completions",
      },
      {
        name: "DeepSeek",
        adapter: deepseekAdapter({
          model: "deepseek-chat",
          apiKey: "deepseek-key",
          fetch: createFetchStub(
            {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: "ok",
                    tool_calls: [
                      {
                        id: "1",
                        type: "function",
                        function: {
                          name: "search",
                          arguments: "{\"q\":\"hi\"}",
                        },
                      },
                    ],
                  },
                },
              ],
            },
            []
          ),
        }),
        expectedUrl: "https://api.deepseek.com/chat/completions",
      },
      {
        name: "Kimi",
        adapter: kimiAdapter({
          model: "kimi-k2.5",
          apiKey: "kimi-key",
          fetch: createFetchStub(
            {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: "ok",
                    tool_calls: [
                      {
                        id: "1",
                        type: "function",
                        function: {
                          name: "search",
                          arguments: "{\"q\":\"hi\"}",
                        },
                      },
                    ],
                  },
                },
              ],
            },
            []
          ),
        }),
        expectedUrl: "https://api.moonshot.ai/v1/chat/completions",
      },
    ] as const;

    for (const config of configs) {
      const callLog: FetchCall[] = [];
      const adapter =
        config.name === "xAI"
          ? xaiAdapter({
              model: "grok-4",
              apiKey: "xai-key",
              fetch: createFetchStub(
                {
                  choices: [
                    {
                      finish_reason: "tool_calls",
                      message: {
                        content: "ok",
                        tool_calls: [
                          {
                            id: "1",
                            type: "function",
                            function: {
                              name: "search",
                              arguments: "{\"q\":\"hi\"}",
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                callLog
              ),
            })
          : config.name === "OpenRouter"
            ? openRouterAdapter({
                model: "openai/gpt-4.1",
                apiKey: "router-key",
                referer: "https://zengent.dev",
                title: "zengent",
                fetch: createFetchStub(
                  {
                    choices: [
                      {
                        finish_reason: "tool_calls",
                        message: {
                          content: "ok",
                          tool_calls: [
                            {
                              id: "1",
                              type: "function",
                              function: {
                                name: "search",
                                arguments: "{\"q\":\"hi\"}",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  callLog
                ),
              })
            : config.name === "DeepSeek"
              ? deepseekAdapter({
                  model: "deepseek-chat",
                  apiKey: "deepseek-key",
                  fetch: createFetchStub(
                    {
                      choices: [
                        {
                          finish_reason: "tool_calls",
                          message: {
                            content: "ok",
                            tool_calls: [
                              {
                                id: "1",
                                type: "function",
                                function: {
                                  name: "search",
                                  arguments: "{\"q\":\"hi\"}",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                    callLog
                  ),
                })
              : kimiAdapter({
                  model: "kimi-k2.5",
                  apiKey: "kimi-key",
                  fetch: createFetchStub(
                    {
                      choices: [
                        {
                          finish_reason: "tool_calls",
                          message: {
                            content: "ok",
                            tool_calls: [
                              {
                                id: "1",
                                type: "function",
                                function: {
                                  name: "search",
                                  arguments: "{\"q\":\"hi\"}",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                    callLog
                  ),
                });

      const result = await exerciseAdapter(adapter);

      expect(result.text).toBe("ok");
      expect(result.toolCalls).toEqual([{ id: "1", name: "search", input: { q: "hi" } }]);
      expect(callLog[0]?.url).toBe(config.expectedUrl);
      expect(getJsonBody(callLog[0]!).tools?.[0]?.function?.name).toBe("search");
    }
  });

  it("adds provider-side structured output when the adapter supports it", async () => {
    const captures = {
      openai: [] as FetchCall[],
      deepseek: [] as FetchCall[],
      gemini: [] as FetchCall[],
      openrouter: [] as FetchCall[],
      xai: [] as FetchCall[],
      kimi: [] as FetchCall[],
      ollama: [] as FetchCall[],
    };

    await exerciseStructuredAdapter(
      openaiAdapter({
        model: "gpt-test",
        apiKey: "openai-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          },
          captures.openai
        ),
      })
    );

    await exerciseStructuredAdapter(
      deepseekAdapter({
        model: "deepseek-chat",
        apiKey: "deepseek-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          },
          captures.deepseek
        ),
      })
    );

    await exerciseStructuredAdapter(
      geminiAdapter({
        model: "gemini-test",
        apiKey: "gemini-key",
        fetch: createFetchStub(
          {
            candidates: [{ content: { parts: [{ text: "{\"answer\":\"ok\"}" }] } }],
          },
          captures.gemini
        ),
      })
    );

    await exerciseStructuredAdapter(
      openRouterAdapter({
        model: "openai/gpt-4.1",
        apiKey: "router-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          },
          captures.openrouter
        ),
      })
    );

    await exerciseStructuredAdapter(
      xaiAdapter({
        model: "grok-4",
        apiKey: "xai-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          },
          captures.xai
        ),
      })
    );

    await exerciseStructuredAdapter(
      kimiAdapter({
        model: "kimi-k2.5",
        apiKey: "kimi-key",
        fetch: createFetchStub(
          {
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          },
          captures.kimi
        ),
      })
    );

    await exerciseStructuredAdapter(
      ollamaAdapter({
        model: "qwen3",
        fetch: createFetchStub(
          {
            message: { content: "{\"answer\":\"ok\"}" },
          },
          captures.ollama
        ),
      })
    );

    const openAiBody = getJsonBody(captures.openai[0]!);
    expect(openAiBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "zengent_output",
        strict: true,
      },
    });
    expect(openAiBody.response_format.json_schema.schema).toMatchObject({
      type: "object",
      properties: {
        answer: {
          type: "string",
        },
      },
      required: ["answer"],
    });

    const deepSeekBody = getJsonBody(captures.deepseek[0]!);
    expect(deepSeekBody.response_format).toEqual({
      type: "json_object",
    });
    expect(deepSeekBody.messages[0]?.content).toContain("Return only valid JSON");
    expect(deepSeekBody.messages[0]?.content).toContain("\"answer\"");

    const geminiBody = getJsonBody(captures.gemini[0]!);
    expect(geminiBody.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
          },
        },
        required: ["answer"],
      },
    });

    for (const body of [
      getJsonBody(captures.openrouter[0]!),
      getJsonBody(captures.xai[0]!),
      getJsonBody(captures.kimi[0]!),
    ]) {
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: {
          name: "zengent_output",
          strict: true,
        },
      });
      expect(body.response_format.json_schema.schema).toMatchObject({
        type: "object",
        properties: {
          answer: {
            type: "string",
          },
        },
        required: ["answer"],
      });
    }

    expect(getJsonBody(captures.ollama[0]!).format).toMatchObject({
      type: "object",
      properties: {
        answer: {
          type: "string",
        },
      },
      required: ["answer"],
    });
  });

  it("falls back to framework-managed JSON guidance when a provider lacks native structured output", async () => {
    const calls: FetchCall[] = [];

    await exerciseStructuredAdapter(
      anthropicAdapter({
        model: "claude-test",
        apiKey: "anthropic-key",
        fetch: createFetchStub(
          {
            content: [{ type: "text", text: "{\"answer\":\"ok\"}" }],
            stop_reason: "end_turn",
          },
          calls
        ),
      })
    );

    const body = getJsonBody(calls[0]!);
    expect(body.system).toContain("Return only valid JSON");
    expect(body.system).toContain("\"answer\"");
    expect(body.response_format).toBeUndefined();
  });

  it("maps Anthropic requests and tool use independently", async () => {
    const calls: FetchCall[] = [];
    const adapter = anthropicAdapter({
      model: "claude-sonnet-4",
      apiKey: "anthropic-key",
      fetch: createFetchStub(
        {
          content: [
            {
              type: "text",
              text: "Let me check.",
            },
            {
              type: "tool_use",
              id: "tool_1",
              name: "search",
              input: {
                q: "weather",
              },
            },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 11,
            output_tokens: 7,
          },
        },
        calls
      ),
    });

    const result = await adapter.generate(
      {
        instructions: "Be helpful",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: "Calling tool",
            metadata: {
              toolCalls: [{ id: "prev_1", name: "search", input: { q: "weather paris" } }],
            },
          },
          {
            role: "tool",
            name: "search",
            toolCallId: "prev_1",
            content: "{\"forecast\":\"sunny\"}",
          },
        ],
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: {
              type: "object",
              properties: {
                q: {
                  type: "string",
                },
              },
            },
          },
        ],
      },
      createRunContext()
    );

    const body = getJsonBody(calls[0]!);

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.init.headers).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01",
    });
    expect(body.system).toBe("Be helpful");
    expect(body.tools[0].input_schema.type).toBe("object");
    expect(body.messages[1].content[1]).toEqual({
      type: "tool_use",
      id: "prev_1",
      name: "search",
      input: { q: "weather paris" },
    });
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "prev_1",
      content: "{\"forecast\":\"sunny\"}",
    });
    expect(result.text).toBe("Let me check.");
    expect(result.toolCalls).toEqual([
      {
        id: "tool_1",
        name: "search",
        input: { q: "weather" },
      },
    ]);
  });

  it("maps Gemini requests and function calls independently", async () => {
    const calls: FetchCall[] = [];
    const adapter = geminiAdapter({
      model: "gemini-2.5-pro",
      apiKey: "gemini-key",
      fetch: createFetchStub(
        {
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  {
                    text: "Sure",
                  },
                  {
                    functionCall: {
                      id: "tool_1",
                      name: "search",
                      args: {
                        q: "weather",
                      },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 5,
            totalTokenCount: 17,
          },
        },
        calls
      ),
    });

    const result = await adapter.generate(
      {
        instructions: "Be helpful",
        messages: [
          { role: "user", content: "Find the weather" },
          {
            role: "assistant",
            content: "Calling tool",
            metadata: {
              toolCalls: [{ id: "prev_1", name: "search", input: { q: "weather paris" } }],
            },
          },
          {
            role: "tool",
            name: "search",
            toolCallId: "prev_1",
            content: "{\"forecast\":\"sunny\"}",
          },
        ],
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: {
              type: "object",
              properties: {
                q: {
                  type: "string",
                },
              },
            },
          },
        ],
      },
      createRunContext()
    );

    const body = getJsonBody(calls[0]!);

    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gemini-key"
    );
    expect(body.system_instruction.parts[0].text).toBe("Be helpful");
    expect(body.contents[1].parts[1].functionCall).toEqual({
      id: "prev_1",
      name: "search",
      args: { q: "weather paris" },
    });
    expect(body.contents[2].parts[0].functionResponse).toEqual({
      name: "search",
      response: {
        toolCallId: "prev_1",
        result: { forecast: "sunny" },
      },
    });
    expect(result.text).toBe("Sure");
    expect(result.toolCalls).toEqual([
      {
        id: "tool_1",
        name: "search",
        input: { q: "weather" },
      },
    ]);
  });

  it("maps Ollama requests and tool calls independently", async () => {
    const calls: FetchCall[] = [];
    const adapter = ollamaAdapter({
      model: "qwen3:latest",
      keepAlive: "5m",
      fetch: createFetchStub(
        {
          message: {
            content: "Local answer",
            tool_calls: [
              {
                function: {
                  name: "search",
                  arguments: {
                    q: "local",
                  },
                },
              },
            ],
          },
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 4,
        },
        calls
      ),
    });

    const result = await exerciseAdapter(adapter);
    const body = getJsonBody(calls[0]!);

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(body.keep_alive).toBe("5m");
    expect(body.tools[0].function.name).toBe("search");
    expect(result.text).toBe("Local answer");
    expect(result.toolCalls).toEqual([
      {
        id: "tool_1",
        name: "search",
        input: { q: "local" },
      },
    ]);
  });

  it("returns readable provider-specific errors", async () => {
    const failingAdapters = [
      {
        label: "OpenAI",
        adapter: openaiAdapter({
          model: "gpt-test",
          apiKey: "openai-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Anthropic",
        adapter: anthropicAdapter({
          model: "claude-test",
          apiKey: "anthropic-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Gemini",
        adapter: geminiAdapter({
          model: "gemini-test",
          apiKey: "gemini-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "xAI",
        adapter: xaiAdapter({
          model: "grok-test",
          apiKey: "xai-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "OpenRouter",
        adapter: openRouterAdapter({
          model: "router-test",
          apiKey: "router-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "DeepSeek",
        adapter: deepseekAdapter({
          model: "deepseek-test",
          apiKey: "deepseek-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Kimi",
        adapter: kimiAdapter({
          model: "kimi-test",
          apiKey: "kimi-key",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Ollama",
        adapter: ollamaAdapter({
          model: "ollama-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
    ];

    for (const { label, adapter } of failingAdapters) {
      await expect(
        adapter.generate(
          {
            messages: [{ role: "user", content: "Hello" }],
          },
          createRunContext()
        )
      ).rejects.toThrow(label);
    }
  });

  it("throws clear missing-key errors only when a request is made", async () => {
    const missingKeyCases = [
      {
        label: "OpenAI",
        envVar: "OPENAI_API_KEY",
        adapter: openaiAdapter("gpt-test"),
        expected: "OpenAI adapter requires an API key. Pass apiKey explicitly or set OPENAI_API_KEY.",
      },
      {
        label: "Anthropic",
        envVar: "ANTHROPIC_API_KEY",
        adapter: anthropicAdapter("claude-test"),
        expected:
          "Anthropic adapter requires an API key. Pass apiKey explicitly or set ANTHROPIC_API_KEY.",
      },
      {
        label: "Gemini",
        envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
        adapter: geminiAdapter("gemini-test"),
        expected:
          "Gemini adapter requires an API key. Pass apiKey explicitly or set GOOGLE_GENERATIVE_AI_API_KEY.",
      },
      {
        label: "xAI",
        envVar: "XAI_API_KEY",
        adapter: xaiAdapter("grok-test"),
        expected: "xAI adapter requires an API key. Pass apiKey explicitly or set XAI_API_KEY.",
      },
      {
        label: "OpenRouter",
        envVar: "OPENROUTER_API_KEY",
        adapter: openRouterAdapter("router-test"),
        expected:
          "OpenRouter adapter requires an API key. Pass apiKey explicitly or set OPENROUTER_API_KEY.",
      },
      {
        label: "DeepSeek",
        envVar: "DEEPSEEK_API_KEY",
        adapter: deepseekAdapter("deepseek-test"),
        expected:
          "DeepSeek adapter requires an API key. Pass apiKey explicitly or set DEEPSEEK_API_KEY.",
      },
      {
        label: "Kimi",
        envVar: "MOONSHOT_API_KEY",
        adapter: kimiAdapter("kimi-test"),
        expected:
          "Kimi adapter requires an API key. Pass apiKey explicitly or set MOONSHOT_API_KEY.",
      },
    ] as const;

    for (const config of missingKeyCases) {
      await withEnv(config.envVar, undefined, async () => {
        await expect(
          config.adapter.generate(
            {
              messages: [{ role: "user", content: "Hello" }],
            },
            createRunContext()
          )
        ).rejects.toThrow(config.expected);
      });
    }
  });

  it("streams Anthropic responses natively", async () => {
    const calls: FetchCall[] = [];
    const adapter = anthropicAdapter({
      model: "claude-test",
      apiKey: "anthropic-key",
      fetch: createTextFetchStub(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
          "",
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          "",
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
          "",
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
          "",
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          "",
          'event: message_stop',
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
        calls,
        {
          headers: {
            "content-type": "text/event-stream",
          },
        }
      ),
    });

    const stream = adapter.streamGenerate!(
      {
        messages: [{ role: "user", content: "Hello" }],
      },
      createRunContext()
    );
    const chunks = await collectStreamChunks(stream);
    const result = await stream.result;

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    expect(getJsonBody(calls[0]!).stream).toBe(true);
  });

  it("streams Gemini responses natively", async () => {
    const calls: FetchCall[] = [];
    const adapter = geminiAdapter({
      model: "gemini-test",
      apiKey: "gemini-key",
      fetch: createTextFetchStub(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}',
          "",
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}',
          "",
        ].join("\n"),
        calls,
        {
          headers: {
            "content-type": "text/event-stream",
          },
        }
      ),
    });

    const stream = adapter.streamGenerate!(
      {
        messages: [{ role: "user", content: "Hello" }],
      },
      createRunContext()
    );
    const chunks = await collectStreamChunks(stream);
    const result = await stream.result;

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    expect(calls[0]!.url).toContain(":streamGenerateContent");
    expect(calls[0]!.url).toContain("alt=sse");
  });

  it("streams Ollama responses natively", async () => {
    const calls: FetchCall[] = [];
    const adapter = ollamaAdapter({
      model: "llama-test",
      fetch: createTextFetchStub(
        [
          JSON.stringify({
            message: {
              content: "Hel",
            },
            done: false,
          }),
          JSON.stringify({
            message: {
              content: "lo",
            },
            done: false,
          }),
          JSON.stringify({
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 2,
          }),
        ].join("\n"),
        calls,
        {
          headers: {
            "content-type": "application/x-ndjson",
          },
        }
      ),
    });

    const stream = adapter.streamGenerate!(
      {
        messages: [{ role: "user", content: "Hello" }],
      },
      createRunContext()
    );
    const chunks = await collectStreamChunks(stream);
    const result = await stream.result;

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    expect(getJsonBody(calls[0]!).stream).toBe(true);
  });

  it("runs through createAgent with every first-party provider adapter", async () => {
    const adapters = [
      openaiAdapter({
        model: "gpt-test",
        apiKey: "openai-key",
        fetch: createFetchStub({
          choices: [{ message: { content: "openai" } }],
        }, []),
      }),
      anthropicAdapter({
        model: "claude-test",
        apiKey: "anthropic-key",
        fetch: createFetchStub({
          content: [{ type: "text", text: "anthropic" }],
          stop_reason: "end_turn",
        }, []),
      }),
      geminiAdapter({
        model: "gemini-test",
        apiKey: "gemini-key",
        fetch: createFetchStub({
          candidates: [{ content: { parts: [{ text: "gemini" }] } }],
        }, []),
      }),
      xaiAdapter({
        model: "grok-test",
        apiKey: "xai-key",
        fetch: createFetchStub({
          choices: [{ message: { content: "xai" } }],
        }, []),
      }),
      openRouterAdapter({
        model: "router-test",
        apiKey: "router-key",
        fetch: createFetchStub({
          choices: [{ message: { content: "openrouter" } }],
        }, []),
      }),
      deepseekAdapter({
        model: "deepseek-test",
        apiKey: "deepseek-key",
        fetch: createFetchStub({
          choices: [{ message: { content: "deepseek" } }],
        }, []),
      }),
      kimiAdapter({
        model: "kimi-test",
        apiKey: "kimi-key",
        fetch: createFetchStub({
          choices: [{ message: { content: "kimi" } }],
        }, []),
      }),
      ollamaAdapter({
        model: "ollama-test",
        fetch: createFetchStub({
          message: { content: "ollama" },
        }, []),
      }),
    ];

    for (const model of adapters) {
      const agent = createAgent({
        name: model.name,
        inputSchema: z.string(),
        outputSchema: z.string(),
        model,
      });
      const result = await agent.run("Hello");

      expect(result.status).toBe("success");

      if (result.status === "success") {
        expect(typeof result.output).toBe("string");
        expect(result.output.length).toBeGreaterThan(0);
      }
    }
  });
});
