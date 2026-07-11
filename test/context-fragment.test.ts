import { describe, expect, it } from "vitest";
import {
  ContextFragmentAccumulator,
  createContextFragment,
  renderContextFragment,
} from "../src/context/fragment.js";
import type { CanonicalMessage } from "../src/providers/types.js";
import { repoMapFragment } from "../src/repomap/index.js";

function fragment(content: string, merge: "append" | "replace" = "append") {
  return createContextFragment({
    source: "test",
    type: "diagnostics",
    role: "user",
    merge,
    visibility: "model",
    trust: "untrusted-environment",
    content,
    maxBytes: 12,
    maxTokens: 3,
  });
}

describe("typed context fragments", () => {
  it("centrally escapes untrusted content and enforces byte/token caps", () => {
    const rendered = renderContextFragment(fragment("<bad>1234567890"));
    expect(rendered.content).toContain("&lt;bad&gt;");
    expect(rendered.content).not.toContain("<bad>");
    expect(rendered.content).toContain("CONTEXT_TRUNCATED");
    expect(rendered.truncated).toBe(true);
  });

  it("applies the byte cap after escaping expansion", () => {
    const rendered = renderContextFragment(fragment("<".repeat(100)));
    const body = rendered.content.split("\n")[1] ?? "";
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(12);
    expect(rendered.truncated).toBe(true);
  });

  it("deduplicates an identical fragment on consecutive turns", () => {
    const messages: CanonicalMessage[] = [];
    expect(
      new ContextFragmentAccumulator().apply(messages, [fragment("same")]),
    ).toHaveLength(1);
    expect(
      new ContextFragmentAccumulator().apply(messages, [fragment("same")]),
    ).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it("replaces rather than appends for replace fragments", () => {
    const messages: CanonicalMessage[] = [];
    const accumulator = new ContextFragmentAccumulator();
    accumulator.apply(messages, [fragment("first", "replace")]);
    accumulator.apply(messages, [fragment("second", "replace")]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("second");
    expect(messages[0]?.content).not.toContain("first");
  });

  it("classifies repository maps as replaceable environment context", () => {
    const repoMap = repoMapFragment("<symbol>", "C:\\repo");
    expect(repoMap.merge).toBe("replace");
    expect(repoMap.trust).toBe("untrusted-environment");
    expect(renderContextFragment(repoMap).content).toContain("&lt;symbol&gt;");
  });
});
