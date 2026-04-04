import { z } from "zod";
import { describe, expect, it } from "vitest";

import { aiSdkAdapter, type AISDKLikeModel } from "../src/adapters/ai-sdk.js";
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

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
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

function getJsonBody(call: FetchCall) {
  return JSON.parse(String(call.init.body ?? "{}"));
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

describe("adapters", () => {
  it("normalizes fake, AI SDK, and OpenAI adapters to the same contract", async () => {
    const fake = createFakeModel([
      {
        text: "hi",
        toolCalls: [{ id: "1", name: "search", input: { q: "hello" } }],
      },
    ]);

    const aiSdkModel: AISDKLikeModel = {
      async generate() {
        return {
          text: "hi",
          toolCalls: [
            {
              toolCallId: "1",
              toolName: "search",
              args: { q: "hello" },
            },
          ],
        };
      },
    };

    const aiSdk = aiSdkAdapter(aiSdkModel);
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

    const [fakeResult, aiSdkResult, openaiResult] = await Promise.all([
      exerciseAdapter(fake),
      exerciseAdapter(aiSdk),
      exerciseAdapter(openai),
    ]);

    expect(fakeResult).toEqual({
      text: "hi",
      toolCalls: [{ id: "1", name: "search", input: { q: "hello" } }],
    });
    expect(aiSdkResult).toEqual(fakeResult);
    expect(openaiResult.text).toBe(fakeResult.text);
    expect(openaiResult.toolCalls).toEqual(fakeResult.toolCalls);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer openai-key",
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
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Anthropic",
        adapter: anthropicAdapter({
          model: "claude-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Gemini",
        adapter: geminiAdapter({
          model: "gemini-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "xAI",
        adapter: xaiAdapter({
          model: "grok-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "OpenRouter",
        adapter: openRouterAdapter({
          model: "router-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "DeepSeek",
        adapter: deepseekAdapter({
          model: "deepseek-test",
          fetch: createFetchStub({}, [], { status: 500, statusText: "Boom" }),
        }),
      },
      {
        label: "Kimi",
        adapter: kimiAdapter({
          model: "kimi-test",
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

  it("runs through createAgent with every first-party provider adapter", async () => {
    const adapters = [
      openaiAdapter({
        model: "gpt-test",
        fetch: createFetchStub({
          choices: [{ message: { content: "openai" } }],
        }, []),
      }),
      anthropicAdapter({
        model: "claude-test",
        fetch: createFetchStub({
          content: [{ type: "text", text: "anthropic" }],
          stop_reason: "end_turn",
        }, []),
      }),
      geminiAdapter({
        model: "gemini-test",
        fetch: createFetchStub({
          candidates: [{ content: { parts: [{ text: "gemini" }] } }],
        }, []),
      }),
      xaiAdapter({
        model: "grok-test",
        fetch: createFetchStub({
          choices: [{ message: { content: "xai" } }],
        }, []),
      }),
      openRouterAdapter({
        model: "router-test",
        fetch: createFetchStub({
          choices: [{ message: { content: "openrouter" } }],
        }, []),
      }),
      deepseekAdapter({
        model: "deepseek-test",
        fetch: createFetchStub({
          choices: [{ message: { content: "deepseek" } }],
        }, []),
      }),
      kimiAdapter({
        model: "kimi-test",
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
