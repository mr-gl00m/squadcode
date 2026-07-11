import { describe, expect, it } from "vitest";
import { HeadTailBuffer } from "../src/tools/output-buffer.js";

describe("head/tail output buffering", () => {
  it("preserves complete output below the cap", () => {
    const buffer = new HeadTailBuffer(10);
    buffer.append(Buffer.from("hello"));
    buffer.append(Buffer.from("!"));
    expect(buffer.render()).toEqual({
      text: "hello!",
      truncated: false,
      omittedBytes: 0,
      totalBytes: 6,
    });
  });

  it("retains both ends and reports the omitted middle", () => {
    const buffer = new HeadTailBuffer(10);
    buffer.append(Buffer.from("0123"));
    buffer.append(Buffer.from("456789ABCDEFGHIJ"));
    const output = buffer.render();
    expect(output.text).toContain("01234");
    expect(output.text).toContain("FGHIJ");
    expect(output.text).toContain("10 bytes omitted");
    expect(output.truncated).toBe(true);
    expect(output.totalBytes).toBe(20);
  });

  it("caps by bytes instead of JavaScript character count", () => {
    const buffer = new HeadTailBuffer(8);
    buffer.append(Buffer.from("🙂🙂🙂"));
    const output = buffer.render();
    expect(output.totalBytes).toBe(12);
    expect(output.omittedBytes).toBe(4);
    expect(output.truncated).toBe(true);
  });
});
