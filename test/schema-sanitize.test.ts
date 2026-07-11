import { describe, expect, it } from "vitest";
import { sanitizeToolSchema } from "../src/providers/schema-sanitize.js";

describe("sanitizeToolSchema — nullable union collapse", () => {
  it("collapses anyOf:[X, {type:null}] into a type array", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: {
        name: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    expect(out.properties).toEqual({
      name: { type: ["string", "null"] },
    });
  });

  it("marks a typeless branch nullable when collapsing", () => {
    const out = sanitizeToolSchema({
      anyOf: [{ properties: { a: { type: "string" } } }, { type: "null" }],
    });
    expect(out).toMatchObject({
      nullable: true,
      properties: { a: { type: "string" } },
    });
    expect(out.anyOf).toBeUndefined();
  });

  it("keeps a multi-branch union but strips the null branch and marks nullable", () => {
    const out = sanitizeToolSchema({
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    });
    expect(out.nullable).toBe(true);
    expect(out.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("preserves sibling keys like description through the collapse", () => {
    const out = sanitizeToolSchema({
      description: "the name",
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(out.description).toBe("the name");
    expect(out.type).toEqual(["string", "null"]);
  });

  it("does not double-add null when type already includes it", () => {
    const out = sanitizeToolSchema({
      anyOf: [{ type: ["string", "null"] }, { type: "null" }],
    });
    expect(out.type).toEqual(["string", "null"]);
  });
});

describe("sanitizeToolSchema — single-element combinators", () => {
  it("merges a single-element allOf up", () => {
    const out = sanitizeToolSchema({
      allOf: [{ type: "string", minLength: 1 }],
    });
    expect(out).toEqual({ type: "string", minLength: 1 });
  });

  it("merges a single-element oneOf up", () => {
    const out = sanitizeToolSchema({ oneOf: [{ type: "boolean" }] });
    expect(out).toEqual({ type: "boolean" });
  });

  it("recursively collapses nested combinators (allOf of anyOf-null)", () => {
    const out = sanitizeToolSchema({
      allOf: [{ anyOf: [{ type: "integer" }, { type: "null" }] }],
    });
    expect(out).toEqual({ type: ["integer", "null"] });
  });

  it("drops an empty combinator", () => {
    const out = sanitizeToolSchema({ type: "string", anyOf: [] });
    expect(out).toEqual({ type: "string" });
  });
});

describe("sanitizeToolSchema — object fixups", () => {
  it("injects properties:{} on a bare object", () => {
    const out = sanitizeToolSchema({ type: "object" });
    expect(out).toEqual({ type: "object", properties: {} });
  });

  it("injects properties:{} when type array includes object", () => {
    const out = sanitizeToolSchema({ type: ["object", "null"] });
    expect(out.properties).toEqual({});
  });

  it("leaves an object with properties untouched", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });
});

describe("sanitizeToolSchema — dangling required", () => {
  it("prunes required names with no matching property", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    });
    expect(out.required).toEqual(["a"]);
  });

  it("drops required entirely when nothing remains", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["ghost"],
    });
    expect(out.required).toBeUndefined();
  });

  it("drops required when there is no properties object at all", () => {
    const out = sanitizeToolSchema({ type: "object", required: ["a"] });
    // properties:{} is injected, then required:["a"] has no match -> dropped
    expect(out.required).toBeUndefined();
    expect(out.properties).toEqual({});
  });
});

describe("sanitizeToolSchema — recursion", () => {
  it("sanitizes nested properties, items, and additionalProperties", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        bag: {
          type: "object",
          additionalProperties: { allOf: [{ type: "number" }] },
        },
        nested: { type: "object" },
      },
      required: ["list"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        list: { type: "array", items: { type: ["string", "null"] } },
        bag: {
          type: "object",
          properties: {},
          additionalProperties: { type: "number" },
        },
        nested: { type: "object", properties: {} },
      },
      required: ["list"],
    });
  });

  it("sanitizes $defs entries", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: {},
      $defs: { Thing: { type: "object" } },
    });
    expect((out.$defs as Record<string, unknown>).Thing).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("sanitizeToolSchema — safety", () => {
  it("does not mutate the input", () => {
    const input = {
      type: "object",
      properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["a", "ghost"],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeToolSchema(input);
    expect(input).toEqual(snapshot);
  });

  it("degrades a non-object schema to the empty object schema", () => {
    expect(sanitizeToolSchema(null)).toEqual({
      type: "object",
      properties: {},
    });
    expect(sanitizeToolSchema("nope")).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("leaves a clean built-in-style schema unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      },
      required: ["command"],
    };
    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it("does not recurse forever on deeply nested schemas", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i++) {
      deep = { type: "object", properties: { next: deep } };
    }
    expect(() => sanitizeToolSchema(deep)).not.toThrow();
  });
});
