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
const PDF_BYTE_THRESHOLD = 25_000_000;
const PDF_PAGE_THRESHOLD = 500;
// Hard byte cap that applies even when offset/limit is provided, so a runaway
// limit can't blow up the conversation. Large but high enough that legitimate
// 8000-line config-file reads still come through.
const HARD_BYTE_CAP = 1_000_000;

export const readTool = defineTool({
  name: "Read",
  description:
    "Read a UTF-8 text file, or a .pdf (text is extracted automatically — no shell or Python needed). Pass offset (1-indexed line) and limit to read a window. Files longer than 2000 lines or 256KB REQUIRE offset/limit — call without them only on small files. The refusal message reports total line count and byte size so you can pick a window directly.",
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
    let raw: string;
    if (isPdfPath(target)) {
      try {
        raw = await extractPdfText(target);
      } catch (err: unknown) {
        if (err instanceof PdfReadLimitError) {
          return {
            ok: false,
            error: "READ_TOO_LARGE_PDF",
            content: err.message,
          };
        }
        throw err;
      }
    } else {
      raw = await fs.readFile(target, "utf-8");
    }
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

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

class PdfReadLimitError extends Error {}

// Extract a PDF's text with the bundled pdf.js build in unpdf — no system
// binary (pdftotext) and no Python+fitz, so "Read that .pdf" behaves like
// reading a text file instead of escalating to a Shell command that prompts.
// The extracted text flows back through the same line-window and size-refusal
// logic as a normal read, so offset/limit work identically. The import is
// dynamic: the pdf.js bundle only loads the first time a PDF is actually read,
// keeping it off the cold-start path for the common text case.
async function extractPdfText(target: string): Promise<string> {
  const handle = await fs.open(target, "r");
  let data: Uint8Array;
  try {
    const stat = await handle.stat();
    if (stat.size > PDF_BYTE_THRESHOLD) {
      throw new PdfReadLimitError(
        `READ_TOO_LARGE_PDF: PDF is ${formatBytes(stat.size)}; maximum supported PDF size is ${formatBytes(PDF_BYTE_THRESHOLD)}`,
      );
    }
    // Read only the byte count validated on this same file handle. A path swap
    // or concurrent file growth cannot turn the pre-read stat into an
    // unbounded allocation.
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    data = new Uint8Array(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  if (pdf.numPages > PDF_PAGE_THRESHOLD) {
    throw new PdfReadLimitError(
      `READ_TOO_LARGE_PDF: PDF has ${pdf.numPages} pages; maximum supported page count is ${PDF_PAGE_THRESHOLD}`,
    );
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n\n") : text;
  if (merged.trim().length === 0) {
    return `(no extractable text in ${totalPages}-page PDF — likely scanned images; OCR is out of scope)`;
  }
  return merged;
}
