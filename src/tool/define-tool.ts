import { ValidationError } from "../core/errors.js";
import type { InferSchema, JsonSchema, RunContext, SchemaLike } from "../core/types.js";
import type { ToolDefinition } from "./tool-types.js";

export interface DefineToolOptions<
  TName extends string,
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
> {
  name: TName;
  description: string;
  inputSchema: TInputSchema;
  jsonSchema?: JsonSchema;
  outputSchema: TOutputSchema;
  execute(
    input: TInputSchema extends SchemaLike<infer TInput> ? TInput : never,
    context: RunContext
  ): Promise<TOutputSchema extends SchemaLike<infer TOutput> ? TOutput : never>
    | (TOutputSchema extends SchemaLike<infer TOutput> ? TOutput : never);
}

export function defineTool<
  const TName extends string,
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
>(
  options: DefineToolOptions<TName, TInputSchema, TOutputSchema>
): ToolDefinition<TInputSchema, InferSchema<TOutputSchema>, TName> {
  // Tools are external capability units. They do not own model execution.
  return {
    kind: "tool",
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    jsonSchema: options.jsonSchema,
    outputSchema: options.outputSchema as SchemaLike<InferSchema<TOutputSchema>>,
    execute: options.execute,
    async invoke(rawInput, context) {
      let parsedInput: TInputSchema extends SchemaLike<infer TInput> ? TInput : never;

      try {
        parsedInput = options.inputSchema.parse(rawInput) as TInputSchema extends SchemaLike<infer TInput>
          ? TInput
          : never;
      } catch (error) {
        throw new ValidationError(`Invalid input for tool "${options.name}"`, {
          cause: error,
        });
      }

      const value = await options.execute(parsedInput, context);

      try {
        return options.outputSchema.parse(value) as InferSchema<TOutputSchema>;
      } catch (error) {
        throw new ValidationError(`Invalid output for tool "${options.name}"`, {
          cause: error,
        });
      }
    },
  };
}
