import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { STREAM_JSON_SCHEMA_VERSION } from "./stream-json.js";

const timestamp = z.string().datetime();

const artifactSchema = z
  .object({
    path: z.string(),
    sha256: z.string(),
    fullSizeBytes: z.number().int().nonnegative(),
  })
  .strict();

const initRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("init"),
    schema_version: z.literal(STREAM_JSON_SCHEMA_VERSION),
    sessionId: z.string(),
    provider: z.string(),
    model: z.string(),
    cwd: z.string(),
    mode: z.string().optional(),
    resumed: z.boolean().optional(),
  })
  .strict();

const messageRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("message"),
    role: z.literal("assistant"),
    text: z.string(),
    reasoning: z.string().optional(),
  })
  .strict();

const toolUseRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    args: z.unknown(),
  })
  .strict();

const toolResultRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("tool_result"),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    content: z.string(),
    error: z.string().optional(),
    reason: z
      .enum(["denied", "executed", "unknown_tool", "aborted"])
      .optional(),
    artifact: artifactSchema.optional(),
  })
  .strict();

const errorRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    cachedInputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  })
  .strict();

const resultRecordSchema = z
  .object({
    ts: timestamp,
    type: z.literal("result"),
    sessionId: z.string(),
    provider: z.string(),
    model: z.string(),
    usage: usageSchema,
    costUsd: z.number().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    exitCode: z.number().int(),
  })
  .strict();

export const streamJsonRecordSchema = z.discriminatedUnion("type", [
  initRecordSchema,
  messageRecordSchema,
  toolUseRecordSchema,
  toolResultRecordSchema,
  errorRecordSchema,
  resultRecordSchema,
]);

export function generateStreamJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(streamJsonRecordSchema, {
    name: "StreamJsonRecord",
    target: "jsonSchema7",
    $refStrategy: "root",
  }) as Record<string, unknown>;
  return {
    $comment: "GENERATED CODE, DO NOT MODIFY BY HAND",
    ...generated,
  };
}
