import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  type ProviderErrorKind,
  toCanonicalErrorEvent,
} from "../src/providers/llm-error.js";

// Minimal stand-in for an SDK APIError: the classifier duck-types these
// fields, so we don't need the real OpenAI/Anthropic error classes.
function apiError(opts: {
  status?: number;
  message?: string;
  code?: string;
  type?: string;
  error?: unknown;
  headers?: Record<string, string>;
}): unknown {
  return {
    name: "APIError",
    message: opts.message ?? "api error",
    status: opts.status,
    code: opts.code,
    type: opts.type,
    error: opts.error,
    headers: opts.headers,
  };
}

describe("classifyProviderError — status mapping", () => {
  const cases: Array<[number, ProviderErrorKind]> = [
    [408, "timeout"],
    [429, "rate_limited"],
    [401, "auth"],
    [403, "auth"],
    [404, "model"],
    [413, "context_length"],
    [500, "server_error"],
    [502, "server_error"],
    [503, "server_error"],
    [422, "invalid_request"],
    [402, "invalid_request"],
  ];
  for (const [status, kind] of cases) {
    it(`maps HTTP ${status} -> ${kind}`, () => {
      expect(classifyProviderError(apiError({ status })).kind).toBe(kind);
    });
  }
});

describe("classifyProviderError — 400 body disambiguation", () => {
  it("reads a context-length 400 from the message", () => {
    const err = apiError({
      status: 400,
      message:
        "This model's maximum context length is 8192 tokens. Reduce the length of the messages.",
    });
    expect(classifyProviderError(err).kind).toBe("context_length");
  });

  it("reads a context-length 400 from the structured body", () => {
    const err = apiError({
      status: 400,
      message: "Bad request",
      error: { code: "context_length_exceeded", type: "invalid_request_error" },
    });
    expect(classifyProviderError(err).kind).toBe("context_length");
  });

  it("reads a content-policy 400", () => {
    const err = apiError({
      status: 400,
      message: "Your request was rejected by the content management policy.",
    });
    expect(classifyProviderError(err).kind).toBe("content_policy");
  });

  it("reads a moderation/safety 400 from the body", () => {
    const err = apiError({
      status: 400,
      message: "Bad request",
      error: { message: "flagged by the safety system" },
    });
    expect(classifyProviderError(err).kind).toBe("content_policy");
  });

  it("falls back to invalid_request when no keyword matches", () => {
    const err = apiError({
      status: 400,
      message: "missing required field 'model'",
    });
    expect(classifyProviderError(err).kind).toBe("invalid_request");
  });

  it("prefers context_length over content_policy when both match", () => {
    const err = apiError({
      status: 400,
      message: "context length exceeded; also flagged by moderation",
    });
    expect(classifyProviderError(err).kind).toBe("context_length");
  });
});

describe("classifyProviderError — transport failures", () => {
  it("maps a Node ECONNREFUSED errno to network", () => {
    const err = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:11434"),
      {
        code: "ECONNREFUSED",
      },
    );
    expect(classifyProviderError(err).kind).toBe("network");
  });

  it("follows err.cause one hop for undici-wrapped failures", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
      }),
    });
    expect(classifyProviderError(err).kind).toBe("network");
  });

  it("maps ETIMEDOUT to timeout", () => {
    const err = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });
    expect(classifyProviderError(err).kind).toBe("timeout");
  });

  it("maps an AbortError name to timeout", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyProviderError(err).kind).toBe("timeout");
  });

  it("infers network from a status-less 'fetch failed' message", () => {
    expect(classifyProviderError(new Error("fetch failed")).kind).toBe(
      "network",
    );
  });

  it("classifies a plain Error with no signal as other (terminal)", () => {
    const c = classifyProviderError(new Error("boom"));
    expect(c.kind).toBe("other");
    expect(c.retryable).toBe(false);
    expect(c.modelVisible).toBe(false);
  });

  it("classifies a SyntaxError as parse", () => {
    expect(
      classifyProviderError(new SyntaxError("Unexpected token")).kind,
    ).toBe("parse");
  });
});

describe("classifyProviderError — retry-after", () => {
  it("parses Retry-After seconds into ms on rate-limit", () => {
    const c = classifyProviderError(
      apiError({ status: 429, headers: { "retry-after": "30" } }),
    );
    expect(c.kind).toBe("rate_limited");
    expect(c.retryAfterMs).toBe(30_000);
  });

  it("parses retry-after-ms when present", () => {
    const c = classifyProviderError(
      apiError({ status: 429, headers: { "retry-after-ms": "1500" } }),
    );
    expect(c.retryAfterMs).toBe(1500);
  });

  it("parses an HTTP-date Retry-After into a positive delay", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const c = classifyProviderError(
      apiError({ status: 429, headers: { "retry-after": future } }),
    );
    expect(c.retryAfterMs).toBeGreaterThan(0);
    expect(c.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("reads Retry-After from a Headers-like object with .get()", () => {
    const headers = new Headers({ "retry-after": "5" });
    const c = classifyProviderError({
      status: 429,
      message: "slow down",
      headers,
    });
    expect(c.retryAfterMs).toBe(5_000);
  });

  it("leaves retryAfterMs unset when no header is present", () => {
    expect(
      classifyProviderError(apiError({ status: 429 })).retryAfterMs,
    ).toBeUndefined();
  });
});

describe("disposition invariant — retryable / modelVisible / terminal", () => {
  const samples: Array<[unknown, ProviderErrorKind]> = [
    [apiError({ status: 429 }), "rate_limited"],
    [apiError({ status: 500 }), "server_error"],
    [Object.assign(new Error("x"), { code: "ECONNRESET" }), "network"],
    [apiError({ status: 408 }), "timeout"],
    [apiError({ status: 401 }), "auth"],
    [apiError({ status: 404 }), "model"],
    [new Error("boom"), "other"],
    [apiError({ status: 422 }), "invalid_request"],
    [
      apiError({ status: 400, message: "content policy violation" }),
      "content_policy",
    ],
    [new SyntaxError("bad json"), "parse"],
    [apiError({ status: 413 }), "context_length"],
  ];

  it("never marks an error both retryable and model-visible", () => {
    for (const [err] of samples) {
      const c = classifyProviderError(err);
      expect(c.retryable && c.modelVisible).toBe(false);
    }
  });

  it("retryable kinds are exactly the transient-infra set", () => {
    const retryable = new Set<ProviderErrorKind>();
    for (const [err, kind] of samples) {
      if (classifyProviderError(err).retryable) retryable.add(kind);
    }
    expect([...retryable].sort()).toEqual(
      ["network", "rate_limited", "server_error", "timeout"].sort(),
    );
  });

  it("model-visible kinds are exactly the model-actionable set", () => {
    const visible = new Set<ProviderErrorKind>();
    for (const [err, kind] of samples) {
      if (classifyProviderError(err).modelVisible) visible.add(kind);
    }
    expect([...visible].sort()).toEqual(
      ["content_policy", "context_length", "invalid_request", "parse"].sort(),
    );
  });
});

describe("toCanonicalErrorEvent", () => {
  it("produces a canonical error event with the taxonomy code", () => {
    const ev = toCanonicalErrorEvent(
      apiError({ status: 429, message: "too many" }),
    );
    expect(ev).toEqual({
      type: "error",
      code: "RATE_LIMITED",
      message: "too many",
      retryable: true,
    });
  });

  it("marks an auth failure non-retryable", () => {
    const ev = toCanonicalErrorEvent(
      apiError({ status: 401, message: "bad key" }),
    );
    expect(ev.type).toBe("error");
    if (ev.type === "error") {
      expect(ev.code).toBe("AUTH");
      expect(ev.retryable).toBe(false);
    }
  });
});
