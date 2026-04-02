import { ValidationError } from "../core/errors.js";
import type { SchemaLike } from "../core/types.js";

export function parseStructuredOutput<TOutput>(
  text: string,
  schema?: SchemaLike<TOutput>
): TOutput | string {
  if (!schema) {
    return text;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Model output is not valid JSON for the configured output schema.", {
      cause: error,
    });
  }

  return schema.parse(payload);
}
