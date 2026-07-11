import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readTool } from "../src/tools/read.js";

const { extractText, getDocumentProxy } = vi.hoisted(() => ({
  extractText: vi.fn(),
  getDocumentProxy: vi.fn(),
}));

vi.mock("unpdf", () => ({ extractText, getDocumentProxy }));

describe("Read PDF hardening", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses oversized PDFs before loading them", async () => {
    dir = mkdtempSync(join(tmpdir(), "squad-pdf-"));
    const pdf = join(dir, "huge.pdf");
    const fd = openSync(pdf, "w");
    try {
      ftruncateSync(fd, 25_000_001);
    } finally {
      closeSync(fd);
    }

    const result = await readTool.execute(
      { path: "huge.pdf" },
      { cwd: dir, signal: new AbortController().signal, callId: "c1" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("READ_TOO_LARGE_PDF");
    expect(getDocumentProxy).not.toHaveBeenCalled();
  });

  it("refuses excessive page counts before extracting text", async () => {
    dir = mkdtempSync(join(tmpdir(), "squad-pdf-"));
    const pdf = join(dir, "many-pages.pdf");
    const fd = openSync(pdf, "w");
    try {
      ftruncateSync(fd, 8);
    } finally {
      closeSync(fd);
    }
    getDocumentProxy.mockResolvedValueOnce({ numPages: 501 });

    const result = await readTool.execute(
      { path: "many-pages.pdf" },
      { cwd: dir, signal: new AbortController().signal, callId: "c2" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("READ_TOO_LARGE_PDF");
    expect(extractText).not.toHaveBeenCalled();
  });
});
