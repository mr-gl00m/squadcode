import { describe, expect, it } from "vitest";
import { parseBlock, parseInline } from "../src/cli/markdown.js";

describe("parseInline", () => {
  it("returns plain text when no markdown delimiters present", () => {
    expect(parseInline("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  it("recognizes a bold span with surrounding text", () => {
    expect(parseInline("hello **brave** world")).toEqual([
      { kind: "text", text: "hello " },
      { kind: "bold", text: "brave" },
      { kind: "text", text: " world" },
    ]);
  });

  it("recognizes an italic span", () => {
    expect(parseInline("just *barely* italic")).toEqual([
      { kind: "text", text: "just " },
      { kind: "italic", text: "barely" },
      { kind: "text", text: " italic" },
    ]);
  });

  it("recognizes a backtick code span", () => {
    expect(parseInline("call `npm test` first")).toEqual([
      { kind: "text", text: "call " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " first" },
    ]);
  });

  it("treats an unclosed bold as plain text", () => {
    expect(parseInline("oh **no")).toEqual([{ kind: "text", text: "oh **no" }]);
  });

  it("treats an unclosed italic as plain text", () => {
    expect(parseInline("oh *no")).toEqual([{ kind: "text", text: "oh *no" }]);
  });

  it("treats an unclosed code span as plain text", () => {
    expect(parseInline("oh `no")).toEqual([{ kind: "text", text: "oh `no" }]);
  });

  it("does not parse markdown inside a backtick code span", () => {
    expect(parseInline("look: `**not bold**`")).toEqual([
      { kind: "text", text: "look: " },
      { kind: "code", text: "**not bold**" },
    ]);
  });

  it("handles bold and italic in the same line", () => {
    expect(parseInline("**bold** and *italic*")).toEqual([
      { kind: "bold", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "italic", text: "italic" },
    ]);
  });

  it("does not match a stray asterisk against double-asterisk neighbors", () => {
    // The `**` is parsed as bold delimiter, so the inner `*` stays as text.
    expect(parseInline("**a*b**")).toEqual([{ kind: "bold", text: "a*b" }]);
  });
});

describe("parseBlock", () => {
  it("recognizes a level-1 header", () => {
    expect(parseBlock("# Title")).toEqual({
      kind: "header",
      level: 1,
      content: "Title",
    });
  });

  it("recognizes a level-3 header", () => {
    expect(parseBlock("### Subsection")).toEqual({
      kind: "header",
      level: 3,
      content: "Subsection",
    });
  });

  it("does not treat a hash without trailing space as a header", () => {
    expect(parseBlock("#hashtag")).toEqual({
      kind: "paragraph",
      content: "#hashtag",
    });
  });

  it("recognizes a dash bullet", () => {
    expect(parseBlock("- item one")).toEqual({
      kind: "bullet",
      indent: "",
      content: "item one",
    });
  });

  it("recognizes an asterisk bullet", () => {
    expect(parseBlock("* item one")).toEqual({
      kind: "bullet",
      indent: "",
      content: "item one",
    });
  });

  it("recognizes a plus bullet", () => {
    expect(parseBlock("+ item one")).toEqual({
      kind: "bullet",
      indent: "",
      content: "item one",
    });
  });

  it("preserves bullet indentation", () => {
    expect(parseBlock("    - nested")).toEqual({
      kind: "bullet",
      indent: "    ",
      content: "nested",
    });
  });

  it("recognizes a numbered list item", () => {
    expect(parseBlock("1. first")).toEqual({
      kind: "numbered",
      indent: "",
      marker: "1",
      content: "first",
    });
  });

  it("recognizes a multi-digit numbered list item", () => {
    expect(parseBlock("12. twelfth")).toEqual({
      kind: "numbered",
      indent: "",
      marker: "12",
      content: "twelfth",
    });
  });

  it("recognizes a fenced-code marker without language", () => {
    expect(parseBlock("```")).toEqual({ kind: "fence", lang: "" });
  });

  it("recognizes a fenced-code marker with language", () => {
    expect(parseBlock("```typescript")).toEqual({
      kind: "fence",
      lang: "typescript",
    });
  });

  it("does not confuse italic with a bullet", () => {
    expect(parseBlock("*italic phrase*")).toEqual({
      kind: "paragraph",
      content: "*italic phrase*",
    });
  });

  it("does not match a bullet without a space after the marker", () => {
    expect(parseBlock("-no-space")).toEqual({
      kind: "paragraph",
      content: "-no-space",
    });
  });

  it("falls back to paragraph for plain text", () => {
    expect(parseBlock("just words")).toEqual({
      kind: "paragraph",
      content: "just words",
    });
  });
});
