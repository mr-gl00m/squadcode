import { describe, expect, it, vi } from "vitest";
import { LocalPermissionGuardian } from "../src/guardian.js";
import type {
  CanonicalRequest,
  CanonicalResponse,
  LLMProvider,
} from "../src/providers/types.js";

function providerWith(
  complete: (request: CanonicalRequest) => Promise<CanonicalResponse>,
): LLMProvider {
  return {
    name: "ollama",
    complete,
    async *stream() {
      yield { type: "done" as const, reason: "stop" as const };
    },
  };
}

const response = (text: string): CanonicalResponse => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

describe("local permission guardian", () => {
  it("returns a parsed advisory and redacts request secrets", async () => {
    const complete = vi.fn(async () =>
      response('{"verdict":"caution","reason":"Review the target path."}'),
    );
    const guardian = new LocalPermissionGuardian(
      providerWith(complete),
      "llama3.2",
    );
    const assessment = await guardian.assessPermission({
      toolName: "Shell",
      callId: "call-1",
      argsPreview: "deploy sk-12345678901234567890",
      scopePattern: "deploy *",
      scopePatterns: ["deploy *"],
    });
    expect(assessment).toEqual({
      verdict: "caution",
      reason: "Review the target path.",
      model: "llama3.2",
    });
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain(
      "sk-12345678901234567890",
    );
  });

  it("fails open as an explicit unavailable advisory", async () => {
    const guardian = new LocalPermissionGuardian(
      providerWith(async () => await new Promise<CanonicalResponse>(() => {})),
      "llama3.2",
      5,
    );
    const assessment = await guardian.assessYolo("C:/repo", "checklist.txt");
    expect(assessment.verdict).toBe("unavailable");
    expect(assessment.reason).toMatch(/timed out/);
  });
});
