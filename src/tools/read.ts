import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

// Sidecars for oversized tool outputs land under ~/.squad/sessions/<id>/artifacts/.
// The model is expected to Read these back when it needs the full output, so
// the Read tool whitelists this subtree even though it's outside cwd.
const SQUAD_SESSIONS_ROOT = join(homedir(), ".squad", "sessions");

const READ_INPUT = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

// Refusal threshold for unscoped reads. Above this, the tool refuses and
// reports the file's size so the caller picks an explicit window the first
// time. Silent head-truncation forces a follow-up Read with offset/limit,
// which doubles the token cost AND fragments the model's view of the file.
// A clean refusal trains the model to scope the call up front.
const REFUSAL_LINE_THRESHOLD = 2000;
const REFUSAL_BYTE_THRESHOLD = 256_000;
// Hard byte cap that applies even when offset/limit is provided, so a runaway
// limit can't blow up the conversation. Large but high enough that legitimate
// 8000-line config-file reads still come through.
const HARD_BYTE_CAP = 1_000_000;

export const readTool = defineTool({
  name: "Read",
  description:
    "Read a UTF-8 text file. Pass offset (1-indexed line) and limit to read a window. Files longer than 2000 lines or 256KB REQUIRE offset/limit — call without them only on small files. The refusal message reports total line count and byte size so you can pick a window directly.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  inputZod: READ_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async (input, ctx) => {
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: true,
      extraAllowedRoots: [SQUAD_SESSIONS_ROOT],
    });
    const raw = await fs.readFile(target, "utf-8");
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;
    const totalBytes = Buffer.byteLength(raw, "utf-8");
    const explicit = input.offset !== undefined || input.limit !== undefined;

    if (
      !explicit &&
      (totalLines > REFUSAL_LINE_THRESHOLD ||
        totalBytes > REFUSAL_BYTE_THRESHOLD)
    ) {
      return {
        ok: false,
        error: "READ_TOO_LARGE",
        content:
          `file ${input.path} is ${totalLines} lines / ${formatBytes(totalBytes)} — ` +
          `unscoped reads above ${REFUSAL_LINE_THRESHOLD} lines or ${formatBytes(REFUSAL_BYTE_THRESHOLD)} are refused. ` +
          `Re-call with offset and limit to read a specific window ` +
          `(e.g. offset=1 limit=2000 for the head, offset=${Math.max(1, totalLines - 1999)} limit=2000 for the tail).`,
      };
    }

    const start = (input.offset ?? 1) - 1;
    const end =
      input.limit !== undefined
        ? Math.min(start + input.limit, totalLines)
        : totalLines;
    let body = lines.slice(start, end).join("\n");
    let byteTrunc = false;
    if (Buffer.byteLength(body, "utf-8") > HARD_BYTE_CAP) {
      const buf = Buffer.from(body, "utf-8").subarray(0, HARD_BYTE_CAP);
      body = buf.toString("utf-8");
      byteTrunc = true;
    }
    if (byteTrunc) {
      body = `${body}\n(window exceeded ${formatBytes(HARD_BYTE_CAP)}; tail elided — narrow the limit)`;
    }
    return { ok: true, content: body };
  },
  summarize: (input, result) => {
    if (!result.ok) return `Read ${input.path} (failed)`;
    const lines = result.content.split("\n").length;
    const bytes = Buffer.byteLength(result.content, "utf-8");
    return `Read ${input.path} (${lines} lines, ${formatBytes(bytes)})`;
  },
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
