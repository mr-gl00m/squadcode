// Tool-schema preflight. Normalizes a JSON Schema into the shape that strict
// provider validators accept before a tool definition is sent upstream.
//
// Built-in tool schemas in this repo are hand-written and already clean; the
// real targets are the schemas that arrive from elsewhere — MCP servers,
// external CLI agents, and (post-v1.2) subagent tool defs — where a generator
// emitted JSON Schema that a strict validator rejects. The four fixups below
// are the ones that bite in practice:
//
//   1. anyOf:[X, {type:"null"}]  -> X marked nullable (the codegen-nullable
//      idiom; some validators reject a 2-branch null union on a tool param).
//   2. type:"object" with no `properties` -> inject `properties: {}` (strict
//      OpenAI function schemas require the key to be present).
//   3. `required` entries not present in `properties` -> pruned (a dangling
//      required name is a hard validation error).
//   4. single-element oneOf/allOf/anyOf -> merged up (a one-branch combinator
//      is noise that some validators still choke on).
//
// Pure and non-mutating: returns a fresh object so the canonical tool spec the
// rest of the system holds stays the faithful original.

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const MAX_DEPTH = 64;

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A schema that means "null and nothing else" — the branch the nullable idiom
// pairs with the real type. Extra keys like `description` on it are ignored.
function isNullSchema(v: unknown): boolean {
  return isPlainObject(v) && v["type"] === "null";
}

// Add a null option to a schema's type. Prefer the JSON-Schema type-array form
// (`["string","null"]`) when there's a concrete type; fall back to `nullable`
// when there's no `type` keyword to extend.
function applyNullable(obj: Json): Json {
  const t = obj["type"];
  if (typeof t === "string") {
    if (t === "null") return obj;
    return { ...obj, type: [t, "null"] };
  }
  if (Array.isArray(t)) {
    if (t.includes("null")) return obj;
    return { ...obj, type: [...t, "null"] };
  }
  return { ...obj, nullable: true };
}

// Resolve a node's own anyOf/oneOf/allOf: strip explicit null branches (marking
// the result nullable), collapse a sole remaining branch up into the node, and
// drop empty combinators. Loops until stable because collapsing one combinator
// can expose another (e.g. allOf:[{anyOf:[X,null]}]).
function collapseCombinators(node: Json): Json {
  let current = node;
  for (let i = 0; i < MAX_DEPTH; i++) {
    let changed = false;
    for (const c of COMBINATORS) {
      const arr = current[c];
      if (!Array.isArray(arr)) continue;

      const nonNull = arr.filter((m) => !isNullSchema(m));
      const hadNull = nonNull.length !== arr.length;
      const { [c]: _omit, ...rest } = current;

      if (arr.length === 0) {
        current = rest;
        changed = true;
        break;
      }
      if (hadNull && nonNull.length === 1) {
        const branch = isPlainObject(nonNull[0]) ? nonNull[0] : {};
        current = applyNullable({ ...rest, ...branch });
        changed = true;
        break;
      }
      if (hadNull && nonNull.length > 1) {
        current = applyNullable({ ...rest, [c]: nonNull });
        changed = true;
        break;
      }
      if (!hadNull && arr.length === 1) {
        const branch = isPlainObject(arr[0]) ? arr[0] : {};
        current = { ...rest, ...branch };
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return current;
}

// Inject `properties: {}` on a bare object and prune `required` names that have
// no matching property. Runs after children are sanitized so `properties` is in
// its final shape.
function fixObjectNode(node: Json): Json {
  const out: Json = { ...node };
  const type = out["type"];
  const isObjectType =
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    (type === undefined && out["properties"] !== undefined);

  if (isObjectType && !isPlainObject(out["properties"])) {
    out["properties"] = {};
  }

  if (Array.isArray(out["required"])) {
    const props = out["properties"];
    if (isPlainObject(props)) {
      const pruned = (out["required"] as unknown[]).filter(
        (r) => typeof r === "string" && r in props,
      );
      if (pruned.length > 0) out["required"] = pruned;
      else delete out["required"];
    } else {
      // required with no properties object to validate against is dangling.
      delete out["required"];
    }
  }

  return out;
}

function sanitizeNode(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return node;
  if (Array.isArray(node)) return node.map((n) => sanitizeNode(n, depth + 1));
  if (!isPlainObject(node)) return node;

  let current = collapseCombinators(node);

  // Recurse into the subschema-bearing keys. Leave $ref/const/enum/etc. alone.
  for (const key of ["properties", "$defs", "definitions"]) {
    const v = current[key];
    if (isPlainObject(v)) {
      const mapped: Json = {};
      for (const [k, sub] of Object.entries(v)) {
        mapped[k] = sanitizeNode(sub, depth + 1);
      }
      current = { ...current, [key]: mapped };
    }
  }
  if (current["items"] !== undefined) {
    current = { ...current, items: sanitizeNode(current["items"], depth + 1) };
  }
  if (isPlainObject(current["additionalProperties"])) {
    current = {
      ...current,
      additionalProperties: sanitizeNode(
        current["additionalProperties"],
        depth + 1,
      ),
    };
  }
  for (const c of COMBINATORS) {
    if (Array.isArray(current[c])) {
      current = {
        ...current,
        [c]: (current[c] as unknown[]).map((n) => sanitizeNode(n, depth + 1)),
      };
    }
  }

  return fixObjectNode(current);
}

// Entry point. Always returns an object schema — a non-object top-level input
// (a tool with a malformed schema) degrades to the empty object schema rather
// than propagating something a provider will reject outright.
export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
  const out = sanitizeNode(schema, 0);
  if (!isPlainObject(out)) return { type: "object", properties: {} };
  return out;
}
