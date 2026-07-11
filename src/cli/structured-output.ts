import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { atomicWriteText } from "../fs-io.js";

const MAX_SCHEMA_BYTES = 256 * 1024;

export interface LoadedOutputSchema {
  path: string;
  schema: Record<string, unknown>;
  instruction: string;
  validate: ValidateFunction;
}

export async function loadOutputSchema(
  path: string,
  cwd: string,
): Promise<LoadedOutputSchema> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > MAX_SCHEMA_BYTES) {
    throw new Error(
      `output schema must be a regular file no larger than ${MAX_SCHEMA_BYTES} bytes`,
    );
  }
  const raw = await readFile(absolute, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("output schema must contain a JSON object");
  }
  const schema = parsed as Record<string, unknown>;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return {
    path: absolute,
    schema,
    validate,
    instruction:
      "The final assistant message must be only one JSON value matching this JSON Schema. Do not wrap it in Markdown fences or add prose.\n" +
      JSON.stringify(schema),
  };
}

export function validateStructuredOutput(
  text: string,
  loaded: LoadedOutputSchema,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (err: unknown) {
    throw new Error(
      `final message is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!loaded.validate(value)) {
    throw new Error(
      `final message does not match ${loaded.path}: ${formatErrors(loaded.validate.errors)}`,
    );
  }
  return value;
}

export async function writeLastMessage(
  path: string,
  cwd: string,
  text: string,
): Promise<void> {
  await atomicWriteText(resolve(cwd, path), text);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "schema validation failed";
  return errors
    .slice(0, 5)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}
