import { ValidationError } from "../core/errors.js";
import type { JsonSchema, RunContext, SchemaLike } from "../core/types.js";
import type { ToolDefinition } from "./tool-types.js";

export interface DefineToolOptions<
  TName extends string,
  TInputSchema extends SchemaLike,
  TOutput,
> {
  name: TName;
  description: string;
  input: TInputSchema;
  inputSchema?: JsonSchema;
  output?: SchemaLike<TOutput>;
  execute(
    input: TInputSchema extends SchemaLike<infer TInput> ? TInput : never,
    context: RunContext
  ): Promise<TOutput> | TOutput;
}

export function defineTool<
  const TName extends string,
  TInputSchema extends SchemaLike,
  TOutput = unknown,
>(
  options: DefineToolOptions<TName, TInputSchema, TOutput>
): ToolDefinition<TInputSchema, TOutput, TName> {
  // Tools are external capability units. They do not own model execution.
  return {
    kind: "tool",
    name: options.name,
    description: options.description,
    input: options.input,
    inputSchema: options.inputSchema,
    output: options.output,
    execute: options.execute,
    async invoke(rawInput, context) {
      let parsedInput: TInputSchema extends SchemaLike<infer TInput> ? TInput : never;

      try {
        parsedInput = options.input.parse(rawInput) as TInputSchema extends SchemaLike<infer TInput>
          ? TInput
          : never;
      } catch (error) {
        throw new ValidationError(`Invalid input for tool "${options.name}"`, {
          cause: error,
        });
      }

      const value = await options.execute(parsedInput, context);

      if (!options.output) {
        return value;
      }

      try {
        return options.output.parse(value);
      } catch (error) {
        throw new ValidationError(`Invalid output for tool "${options.name}"`, {
          cause: error,
        });
      }
    },
  };
}
