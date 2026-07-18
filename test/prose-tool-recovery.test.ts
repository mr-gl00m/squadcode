import { describe, expect, it } from "vitest";
import {
  ProseToolScanner,
  recoverProseToolCalls,
  stripNamespace,
} from "../src/providers/prose-tool-recovery.js";
import type {
  CanonicalEvent,
  CanonicalToolCall,
} from "../src/providers/types.js";

// --- helpers ---------------------------------------------------------------

async function* fromChunks(
  chunks: string[],
  extra?: { native?: CanonicalToolCall[] },
): AsyncIterable<CanonicalEvent> {
  for (const c of chunks) yield { type: "text_delta", text: c };
  if (extra?.native) {
    for (const n of extra.native) {
      yield { type: "tool_call_done", id: n.id, name: n.name, args: n.args };
    }
  }
  yield {
    type: "usage",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  yield { type: "done", reason: "stop" };
}

async function collect(
  it: AsyncIterable<CanonicalEvent>,
): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function visibleText(events: CanonicalEvent[]): string {
  return events
    .filter(
      (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
        e.type === "text_delta",
    )
    .map((e) => e.text)
    .join("");
}

function recoveredCalls(
  events: CanonicalEvent[],
): { name: string; args: unknown }[] {
  return events
    .filter(
      (e): e is Extract<CanonicalEvent, { type: "tool_call_done" }> =>
        e.type === "tool_call_done",
    )
    .map((e) => ({ name: e.name, args: e.args }));
}

async function run(
  chunks: string[],
  extra?: { native?: CanonicalToolCall[] },
): Promise<{
  text: string;
  calls: { name: string; args: unknown }[];
  events: CanonicalEvent[];
}> {
  const events = await collect(
    recoverProseToolCalls(fromChunks(chunks, extra)),
  );
  return { text: visibleText(events), calls: recoveredCalls(events), events };
}

// --- supported wrappers ----------------------------------------------------

describe("prose recovery: supported wrapper forms", () => {
  it("recovers a Hermes <tool_call> block", async () => {
    const { text, calls } = await run([
      '<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>',
    ]);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
    expect(text).toBe("");
  });

  it("recovers an <invoke name> block (args in body)", async () => {
    const { calls } = await run([
      '<invoke name="Read">{"path":"a.ts"}</invoke>',
    ]);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
  });

  it("recovers an <invoke> block with name in the JSON body", async () => {
    const { calls } = await run([
      '<invoke>{"name":"Read","arguments":{"path":"a.ts"}}</invoke>',
    ]);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
  });

  it("recovers a Llama <function=name> block", async () => {
    const { calls } = await run(['<function=Read>{"path":"a.ts"}</function>']);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
  });
});

// --- namespace normalization ----------------------------------------------

describe("prose recovery: namespace normalization", () => {
  it("strips functions. and default_api: prefixes", () => {
    expect(stripNamespace("functions.Read")).toBe("Read");
    expect(stripNamespace("default_api:Write")).toBe("Write");
    expect(stripNamespace("default_api.Read")).toBe("Read");
    expect(stripNamespace("functions.default_api.Grep")).toBe("Grep");
  });

  it("normalizes a namespaced name in a recovered call", async () => {
    const { calls } = await run([
      '<tool_call>{"name":"functions.Read","arguments":{"path":"a"}}</tool_call>',
    ]);
    expect(calls).toEqual([{ name: "Read", args: { path: "a" } }]);
  });
});

// --- chunking / split points ----------------------------------------------

describe("prose recovery: incremental parsing", () => {
  const wrapper =
    'before <tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call> after';

  it("recovers across one-character chunks", async () => {
    const { text, calls } = await run(wrapper.split(""));
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("<tool_call");
  });

  it("recovers at every split point", async () => {
    for (let i = 0; i <= wrapper.length; i += 1) {
      const { text, calls } = await run([
        wrapper.slice(0, i),
        wrapper.slice(i),
      ]);
      expect(calls, `split at ${i}`).toEqual([
        { name: "Read", args: { path: "a.ts" } },
      ]);
      expect(text, `split at ${i}`).not.toContain("<tool_call");
    }
  });

  it("keeps prose before and after in order", async () => {
    const { text, events } = await run([wrapper]);
    expect(text).toBe("before  after");
    const order = events.map((e) => e.type);
    expect(order.indexOf("tool_call_done")).toBeGreaterThan(0);
  });

  it("recovers two wrappers in one response", async () => {
    const { calls } = await run([
      '<function=Read>{"path":"a"}</function> and <function=Write>{"path":"b"}</function>',
    ]);
    expect(calls).toEqual([
      { name: "Read", args: { path: "a" } },
      { name: "Write", args: { path: "b" } },
    ]);
  });
});

// --- arg-repair integration ------------------------------------------------

describe("prose recovery: argument repair", () => {
  it("repairs a trailing comma via the arg-repair ladder", async () => {
    const { calls } = await run(['<function=Read>{"path":"a.ts",}</function>']);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
  });

  it("repairs an unclosed argument object", async () => {
    const { calls } = await run(['<function=Read>{"path":"a.ts"</function>']);
    expect(calls).toEqual([{ name: "Read", args: { path: "a.ts" } }]);
  });

  it("leaves an unrecoverable body as visible text", async () => {
    const { text, calls } = await run(["<tool_call>not json here</tool_call>"]);
    expect(calls).toEqual([]);
    expect(text).toBe("<tool_call>not json here</tool_call>");
  });
});

// --- false-positive defenses ----------------------------------------------

describe("prose recovery: false-positive defenses", () => {
  it("does not recover a wrapper inside a fenced code block", async () => {
    const src =
      '```\n<tool_call>{"name":"Read","arguments":{}}</tool_call>\n```';
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("does not recover a wrapper inside inline code", async () => {
    const src = "use the `<function=Read>{}` form to call a tool";
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("does not recover a wrapper inside a two-backtick code span", async () => {
    const src = "use ``<function=Read>{}`` as an example";
    const { text, calls } = await run(src.split(""));
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("does not recover wrappers in blockquotes or double-quoted examples", async () => {
    const wrapper = '<tool_call>{"name":"Read","arguments":{}}</tool_call>';
    for (const src of [`> Example: ${wrapper}`, `"Example: ${wrapper}"`]) {
      const { text, calls } = await run(src.split(""));
      expect(calls, src).toEqual([]);
      expect(text, src).toBe(src);
    }
  });

  it("does not recover a fenced wrapper split across chunks", async () => {
    const src = '```\n<invoke name="Read">{"path":"a"}</invoke>\n```';
    const { text, calls } = await run(src.split(""));
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("passes an ordinary angle bracket through as prose", async () => {
    const { text, calls } = await run(["1 < 2 and 3 > 2, so <b>bold</b>"]);
    expect(calls).toEqual([]);
    expect(text).toBe("1 < 2 and 3 > 2, so <b>bold</b>");
  });
});

// --- limits ----------------------------------------------------------------

describe("prose recovery: safety limits", () => {
  it("flushes an unterminated wrapper as visible text", async () => {
    const src = '<tool_call>{"name":"Read","arguments":{"path":"a"';
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("does not recover an oversized unterminated wrapper", async () => {
    const big = "x".repeat(70 * 1024);
    const src = `<tool_call>{"name":"Read","arguments":{"blob":"${big}`;
    const { calls } = await run([src]);
    expect(calls).toEqual([]);
  });

  it("does not recover an oversized complete wrapper", async () => {
    const big = "x".repeat(70 * 1024);
    const src = `<tool_call>{"name":"Read","arguments":{"blob":"${big}"}}</tool_call>`;
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });

  it("rejects multiple JSON objects in one wrapper", async () => {
    const src = "<tool_call>{}{}</tool_call>";
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });
});

// --- native precedence -----------------------------------------------------

describe("prose recovery: native precedence and dedup", () => {
  it("passes a native-only stream through unchanged", async () => {
    const { text, calls } = await run(["here is the answer"], {
      native: [{ id: "call_0", name: "Read", args: { path: "a" } }],
    });
    expect(text).toBe("here is the answer");
    expect(calls).toEqual([{ name: "Read", args: { path: "a" } }]);
  });

  it("suppresses a native call that duplicates a recovered one", async () => {
    const { calls, events } = await run(
      ['<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>'],
      { native: [{ id: "call_0", name: "Read", args: { path: "a" } }] },
    );
    expect(calls).toEqual([{ name: "Read", args: { path: "a" } }]);
    const call = events.find((event) => event.type === "tool_call_done");
    expect(call?.id).toBe("call_0");
  });

  it("suppresses recovered prose that duplicates an earlier native call", async () => {
    async function* source(): AsyncIterable<CanonicalEvent> {
      yield {
        type: "tool_call_done",
        id: "call_0",
        name: "Read",
        args: { path: "a" },
      };
      yield {
        type: "text_delta",
        text: '<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>',
      };
      yield { type: "done", reason: "tool_use" };
    }
    const events = await collect(recoverProseToolCalls(source()));
    expect(recoveredCalls(events)).toEqual([
      { name: "Read", args: { path: "a" } },
    ]);
    const call = events.find((event) => event.type === "tool_call_done");
    expect(call?.id).toBe("call_0");
  });

  it("keeps a native call that differs from the recovered one", async () => {
    const { calls } = await run(
      ['<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>'],
      { native: [{ id: "call_0", name: "Write", args: { path: "b" } }] },
    );
    expect(calls).toEqual([
      { name: "Read", args: { path: "a" } },
      { name: "Write", args: { path: "b" } },
    ]);
  });
});

// --- tool name validation --------------------------------------------------

describe("prose recovery: tool name validation", () => {
  it("accepts allowed punctuation in a name", async () => {
    const { calls } = await run(['<function=my-tool_v2.x>{"a":1}</function>']);
    expect(calls).toEqual([{ name: "my-tool_v2.x", args: { a: 1 } }]);
  });

  it("rejects a name with a space and leaves it visible", async () => {
    const src = '<tool_call>{"name":"bad name","arguments":{}}</tool_call>';
    const { text, calls } = await run([src]);
    expect(calls).toEqual([]);
    expect(text).toBe(src);
  });
});

// --- unicode and CRLF ------------------------------------------------------

describe("prose recovery: unicode and CRLF", () => {
  it("preserves unicode argument values", async () => {
    const { calls } = await run([
      '<function=Read>{"path":"café/日本.ts","note":"naïve → ok"}</function>',
    ]);
    expect(calls).toEqual([
      { name: "Read", args: { path: "café/日本.ts", note: "naïve → ok" } },
    ]);
  });

  it("handles CRLF whitespace around the JSON body", async () => {
    const { calls } = await run([
      '<tool_call>\r\n{"name":"Read","arguments":{"path":"a"}}\r\n</tool_call>',
    ]);
    expect(calls).toEqual([{ name: "Read", args: { path: "a" } }]);
  });
});

// --- passthrough toggle ----------------------------------------------------

describe("prose recovery: disabled", () => {
  it("passes wrappers through untouched when disabled", async () => {
    const src = '<tool_call>{"name":"Read","arguments":{}}</tool_call>';
    const events = await collect(
      recoverProseToolCalls(fromChunks([src]), { enabled: false }),
    );
    expect(recoveredCalls(events)).toEqual([]);
    expect(visibleText(events)).toBe(src);
  });
});

// --- scanner direct --------------------------------------------------------

describe("ProseToolScanner", () => {
  it("assigns collision-resistant ids within one response", async () => {
    const { events } = await run([
      '<function=Read>{"a":1}</function><function=Read>{"a":2}</function>',
    ]);
    const ids = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "tool_call_done" }> =>
          e.type === "tool_call_done",
      )
      .map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2);
  });

  it("streams ordinary text with no wrapper unchanged", () => {
    const s = new ProseToolScanner();
    const evs = [...s.push("hello world, no tools here"), ...s.flush()];
    expect(visibleText(evs)).toBe("hello world, no tools here");
    expect(recoveredCalls(evs)).toEqual([]);
  });
});
