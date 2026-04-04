import { z } from "zod";

import { AgentExecutionError, ConfigError, TimeoutError, ToolExecutionError } from "../core/errors.js";
import type { RunResult, StepTrace, ToolTrace } from "../core/result.js";
import type { JsonSchema, Message, ModelAdapter, ModelResponse, RunContext, SchemaLike } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolDefinition } from "../tool/tool-types.js";
import { createStopPolicy, type StopPolicy } from "./stop-policy.js";
import { parseStructuredOutput } from "./structured-output.js";
import type { AgentPromptArgs, AgentRunOptions, ToolPolicy } from "./create-agent.js";

interface ExecuteAgentRunOptions<TInput, TOutput> {
  name: string;
  instructions?: string;
  prompt?: (args: AgentPromptArgs<TInput>) => string;
  model: ModelAdapter;
  tools: readonly ToolDefinition[];
  outputSchema: SchemaLike<TOutput>;
  stopPolicy?: Partial<StopPolicy>;
  toolPolicy?: ToolPolicy;
  input: TInput;
  context: RunContext;
  memory?: MemoryStore;
  runOptions?: AgentRunOptions;
}

function isMessageArray(input: unknown): input is Message[] {
  return (
    Array.isArray(input) &&
    input.every(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "role" in value &&
        "content" in value
    )
  );
}

function toMessages<TInput>(
  input: TInput,
  prompt?: (args: AgentPromptArgs<TInput>) => string
): Message[] {
  if (prompt) {
    return [{ role: "user", content: prompt({ input }) }];
  }

  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (isMessageArray(input)) {
    return [...input];
  }

  return [{ role: "user", content: stringifyPayload(input) }];
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function toToolInputJsonSchema(tool: ToolDefinition): JsonSchema {
  return z.toJSONSchema(tool.inputSchema) as JsonSchema;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function withTimeout<TValue>(
  work: Promise<TValue>,
  timeoutMs?: number
): Promise<TValue> {
  if (!timeoutMs || timeoutMs <= 0) {
    return work;
  }

  return await new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Tool execution timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function executeTool(
  tool: ToolDefinition,
  callId: string,
  input: unknown,
  context: RunContext,
  policy: ToolPolicy,
  traces: ToolTrace[]
): Promise<unknown> {
  const retries = policy.retries ?? 0;
  const attempts = retries + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await context.emit({
      type: "tool.started",
      tool: tool.name,
      callId,
      input,
      attempt,
    });

    try {
      const output = await withTimeout(
        Promise.resolve(tool.invoke(input, context)),
        policy.timeoutMs
      );

      traces.push({
        name: tool.name,
        callId,
        input,
        output,
        attempt,
      });

      await context.emit({
        type: "tool.completed",
        tool: tool.name,
        callId,
        output,
        attempt,
      });

      return output;
    } catch (error) {
      lastError = toError(error);
      traces.push({
        name: tool.name,
        callId,
        input,
        error: lastError.message,
        attempt,
      });

      await context.emit({
        type: "tool.failed",
        tool: tool.name,
        callId,
        error: lastError.message,
        attempt,
      });
    }
  }

  throw new ToolExecutionError(
    `Tool "${tool.name}" failed after ${attempts} attempt(s).`,
    { cause: lastError }
  );
}

function finalizeResult<TOutput>(
  result: RunResult<TOutput>,
  steps: StepTrace[],
  toolTraces: ToolTrace[],
  messages: Message[]
): RunResult<TOutput> {
  return {
    ...result,
    steps,
    toolTraces,
    messages,
  };
}

function resolveAgentOutput<TOutput>(
  response: ModelResponse<TOutput>,
  finalText: string | undefined,
  outputSchema: SchemaLike<TOutput>
): TOutput {
  if (response.output !== undefined) {
    return outputSchema.parse(response.output);
  }

  if (finalText === undefined) {
    throw new AgentExecutionError("Model output is missing.");
  }

  try {
    return outputSchema.parse(finalText);
  } catch {
    return parseStructuredOutput(finalText, outputSchema) as TOutput;
  }
}

export async function executeAgentRun<TInput, TOutput>(
  options: ExecuteAgentRunOptions<TInput, TOutput>
): Promise<RunResult<TOutput>> {
  const stopPolicy = createStopPolicy(options.stopPolicy);
  const toolPolicy: ToolPolicy = {
    retries: options.toolPolicy?.retries ?? 0,
    timeoutMs: options.toolPolicy?.timeoutMs,
  };
  const steps: StepTrace[] = [];
  const toolTraces: ToolTrace[] = [];
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const memory = options.runOptions?.memory ?? options.memory;
  const threadId = options.runOptions?.threadId;
  const historicalMessages =
    memory && threadId ? (await memory.getThread(threadId))?.messages ?? [] : [];
  const runMessages = toMessages(options.input, options.prompt);
  const messages: Message[] = [...historicalMessages, ...runMessages];
  const appendFrom = historicalMessages.length;

  await options.context.emit({
    type: "run.started",
    name: options.name,
    input: options.input,
  });

  try {
    for (let step = 1; step <= stopPolicy.maxSteps; step += 1) {
      await options.context.emit({
        type: "model.started",
        adapter: options.model.name,
        step,
        messages,
      });

      const response = await options.model.generate(
        {
          instructions: options.instructions,
          messages,
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: toToolInputJsonSchema(tool),
          })),
          outputSchema: options.outputSchema,
          signal: options.context.signal,
          metadata: options.context.metadata,
        },
        options.context
      );

      steps.push({
        name: `model:${step}`,
        type: "model",
        input: messages,
        output: response,
      });

      await options.context.emit({
        type: "model.completed",
        adapter: options.model.name,
        step,
        response,
      });

      if (response.toolCalls && response.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: response.text ?? "",
          metadata: {
            toolCalls: response.toolCalls,
          },
        });

        for (const call of response.toolCalls) {
          const tool = toolsByName.get(call.name);

          if (!tool) {
            throw new ConfigError(`Agent "${options.name}" does not have a tool named "${call.name}".`);
          }

          const output = await executeTool(
            tool,
            call.id,
            call.input,
            options.context,
            toolPolicy,
            toolTraces
          );

          steps.push({
            name: `tool:${tool.name}`,
            type: "tool",
            input: call.input,
            output,
          });

          messages.push({
            role: "tool",
            name: tool.name,
            toolCallId: call.id,
            content: stringifyPayload(output),
          });
        }

        if (step < stopPolicy.maxSteps) {
          continue;
        }

        throw new AgentExecutionError(
          `Agent "${options.name}" reached its maximum number of steps (${stopPolicy.maxSteps}).`
        );
      }

      const finalText =
        response.text ??
        (response.output === undefined ? undefined : stringifyPayload(response.output));

      if (!finalText && response.output === undefined) {
        throw new AgentExecutionError(
          `Model "${options.model.name}" returned neither text nor tool calls.`
        );
      }

      const output = resolveAgentOutput(response, finalText, options.outputSchema);

      if (finalText) {
        messages.push({
          role: "assistant",
          content: finalText,
        });
      }

      const result = finalizeResult<TOutput>(
        {
          status: "success",
          output,
          text: finalText,
          steps: [],
          toolTraces: [],
          messages: [],
        },
        steps,
        toolTraces,
        messages
      );

      if (memory && threadId) {
        await memory.appendMessages(threadId, messages.slice(appendFrom));
      }

      await options.context.emit({
        type: "run.completed",
        name: options.name,
        status: result.status,
      });

      return result;
    }
  } catch (error) {
    const result = finalizeResult<TOutput>(
      {
        status: "failed",
        error: toError(error),
        steps: [],
        toolTraces: [],
        messages: [],
      },
      steps,
      toolTraces,
      messages
    );

    if (memory && threadId) {
      await memory.appendMessages(threadId, messages.slice(appendFrom));
    }

    await options.context.emit({
      type: "run.completed",
      name: options.name,
      status: result.status,
    });

    return result;
  }

  const failure = finalizeResult<TOutput>(
    {
      status: "failed",
      error: new AgentExecutionError(
        `Agent "${options.name}" reached its maximum number of steps (${stopPolicy.maxSteps}).`
      ),
      steps: [],
      toolTraces: [],
      messages: [],
    },
    steps,
    toolTraces,
    messages
  );

  await options.context.emit({
    type: "run.completed",
    name: options.name,
    status: failure.status,
  });

  return failure;
}
